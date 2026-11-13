import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  checkClaudeCli,
  checkDiskSpace,
  checkNativeModule,
  checkNodeVersion,
  checkPortFree,
  compareVersions,
  formatCheck,
  MIN_NODE,
  summarize,
  type Check,
} from "../src/lib/preflight";

/**
 * Preflight tests — RVOS-003 P4.
 *
 * The installer runs on Windows, which cannot be tested from here. So the
 * DECISION logic lives in TypeScript and is tested on any OS, and the
 * PowerShell is kept to orchestration only. Anything that decides pass/fail
 * belongs on this side of that line.
 */

test("version comparison handles prefixes, suffixes and short forms", () => {
  assert.equal(compareVersions("20.0.0", "20.0.0"), 0);
  assert.equal(compareVersions("v22.3.1", "20.0.0"), 1);
  assert.equal(compareVersions("18.19.0", "20.0.0"), -1);
  assert.equal(compareVersions("v20", "20.0.0"), 0, "a short form is not older");
  assert.equal(compareVersions("21.0.0-nightly", "20.0.0"), 1);
  // The classic: string comparison would call this older.
  assert.equal(compareVersions("20.10.0", "20.9.0"), 1);
});

test("an old Node is fatal and says exactly what to install", () => {
  const c = checkNodeVersion("18.19.0");
  assert.equal(c.ok, false);
  assert.equal(c.fatal, true);
  assert.match(c.fix!, /nodejs\.org/);
  assert.match(c.fix!, new RegExp(MIN_NODE.split(".")[0]));
});

test("the current Node passes its own check", () => {
  assert.equal(checkNodeVersion(process.version).ok, true);
});

test("the native module loads and actually round-trips a row", () => {
  const c = checkNativeModule();
  assert.equal(c.ok, true, `better-sqlite3 failed to load: ${c.detail}`);
  assert.equal(c.fatal, true);
});

test("a native-module failure explains the rebuild, not the stack trace", () => {
  // Simulated: the real failure mode is an ABI mismatch after a Node upgrade,
  // which cannot be provoked here without breaking the install.
  const c: Check = {
    name: "better-sqlite3 (native)",
    ok: false,
    fatal: true,
    detail: "NODE_MODULE_VERSION 115 vs 127",
    fix: "npm rebuild better-sqlite3",
  };
  assert.equal(summarize([c]).ok, false);
  assert.equal(summarize([c]).fatalFailures.length, 1);
});

test("disk space is a warning, never fatal", () => {
  const c = checkDiskSpace(process.cwd(), 1);
  assert.equal(c.ok, true);
  assert.equal(c.fatal, false);
  const tight = checkDiskSpace(process.cwd(), Number.MAX_SAFE_INTEGER);
  assert.equal(tight.ok, false);
  assert.equal(tight.fatal, false, "a full disk should not block an install outright");
});

test("a writable data directory passes; an impossible one fails fatally", async () => {
  const { checkWritable } = await import("../src/lib/preflight");
  const dir = mkdtempSync(path.join(tmpdir(), "revenueos-pre-"));
  try {
    const ok = checkWritable(path.join(dir, "data"));
    assert.equal(ok.ok, true);
    assert.equal(ok.fatal, true);
    // A path that cannot be created at all: its parent is a FILE. Fails with
    // ENOTDIR/ENOENT on every OS. (The old probe, a path under /proc, makes
    // Node's recursive mkdir spin forever on Linux and hung the whole suite.)
    const blocker = path.join(dir, "blocker");
    writeFileSync(blocker, "x");
    const bad = checkWritable(path.join(blocker, "revenueos"));
    assert.equal(bad.ok, false);
    assert.match(bad.fix!, /Program Files/, "the Windows-specific cause must be named");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a free port passes and a taken one warns without being fatal", async () => {
  const free = await checkPortFree(0);
  assert.equal(free.ok, true);

  const { createServer } = await import("node:net");
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  try {
    const taken = await checkPortFree(port);
    assert.equal(taken.ok, false);
    assert.equal(taken.fatal, false, "the app may already be running — that is not an error");
    assert.match(taken.detail, /in use/);
  } finally {
    server.close();
  }
});

test("a missing claude CLI degrades rather than blocking, and says what still works", () => {
  const c = checkClaudeCli((() => ({
    status: 127,
    error: undefined,
    stdout: "",
    stderr: "command not found",
  })) as unknown as typeof import("node:child_process").spawnSync);
  assert.equal(c.ok, false);
  assert.equal(c.fatal, false, "the books must be usable without photo extraction");
  assert.match(c.fix!, /claude login/);
  assert.match(c.fix!, /Tally|Excel|manual/i, "say what the office CAN still do");
});

test("a present claude CLI does NOT claim to have verified sign-in", () => {
  const c = checkClaudeCli((() => ({
    status: 0,
    error: undefined,
    stdout: "1.2.3 (Claude Code)",
    stderr: "",
  })) as unknown as typeof import("node:child_process").spawnSync);
  assert.equal(c.ok, true);
  // Presence is cheap; authentication costs a real request. Claiming the
  // latter would surface as a cryptic failure on the office's first ledger
  // photo — the worst possible moment to discover it.
  assert.match(c.detail, /sign-in NOT verified/i);
  assert.match(c.fix!, /theirs, not the installer/i, "whose account it is, is the point");
});

test("summarize separates fatal from degraded", () => {
  const checks: Check[] = [
    { name: "a", ok: true, fatal: true, detail: "" },
    { name: "b", ok: false, fatal: false, detail: "" },
    { name: "c", ok: false, fatal: true, detail: "" },
  ];
  const s = summarize(checks);
  assert.equal(s.ok, false);
  assert.deepEqual(s.fatalFailures.map((c) => c.name), ["c"]);
  assert.deepEqual(s.warnings.map((c) => c.name), ["b"]);

  const clean = summarize([{ name: "a", ok: true, fatal: true, detail: "" }]);
  assert.equal(clean.ok, true);
});

test("formatting marks fatal and degraded differently", () => {
  assert.match(formatCheck({ name: "x", ok: true, fatal: true, detail: "d" }), /^ {2}✓/);
  assert.match(formatCheck({ name: "x", ok: false, fatal: true, detail: "d" }), /^ {2}✗/);
  assert.match(formatCheck({ name: "x", ok: false, fatal: false, detail: "d" }), /^ {2}!/);
});
