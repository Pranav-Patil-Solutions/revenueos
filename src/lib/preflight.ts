import { accessSync, constants, mkdirSync, rmSync, statfsSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

/**
 * Install preflight — RVOS-003 P4.
 *
 * Everything that must be true before RevenueOS can run on a machine that is
 * NOT the developer's. Each check answers with a fix a non-developer can
 * actually carry out, because the person reading this output is an accountant
 * with a deadline, not the person who wrote the app.
 *
 * The checks are pure-ish and individually exported so they can be unit
 * tested on any OS — the Windows installer calls the same functions it will
 * fail on, rather than duplicating the logic in PowerShell where nothing
 * tests it.
 */

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
  /** A failed fatal check means the app will not work. Non-fatal = degraded. */
  fatal: boolean;
  /** What the operator should DO. Written for a non-developer. */
  fix?: string;
}

/** Minimum Node. better-sqlite3 prebuilds and Next 16 both need modern Node. */
export const MIN_NODE = "20.0.0";
export const APP_PORT = 3322;
/** Refuse to install with less headroom than this — books plus backups. */
export const MIN_FREE_BYTES = 2 * 1024 * 1024 * 1024;

/** Compare dotted versions. -1 / 0 / 1. Ignores any "v" prefix and suffixes
 * like "-nightly" — only the numeric triple is compared. */
export function compareVersions(a: string, b: string): number {
  const nums = (v: string) =>
    v.replace(/^v/, "").split(/[.\-+]/).slice(0, 3).map((n) => Number.parseInt(n, 10) || 0);
  const [x, y] = [nums(a), nums(b)];
  for (let i = 0; i < 3; i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0) ? -1 : 1;
  }
  return 0;
}

export function checkNodeVersion(actual: string, min: string = MIN_NODE): Check {
  const ok = compareVersions(actual, min) >= 0;
  return {
    name: "Node.js version",
    ok,
    fatal: true,
    detail: ok ? `${actual} (needs ${min}+)` : `${actual} is too old — needs ${min} or newer`,
    fix: ok
      ? undefined
      : `Install Node.js ${min}+ from https://nodejs.org (choose the LTS build), ` +
        `then run this again.`,
  };
}

/**
 * The single most likely Windows install failure: better-sqlite3 is a NATIVE
 * module and needs a prebuilt binary matching this exact Node ABI, or a
 * toolchain to compile one.
 */
export function checkNativeModule(): Check {
  try {
    // Loaded LAZILY and on purpose. A static import would throw while this
    // module is still being evaluated, so an ABI mismatch would crash the
    // preflight with a stack trace instead of printing the rebuild
    // instructions it exists to print. createRequire keeps that laziness
    // while satisfying the no-require-imports lint rule.
    const requireFrom = createRequire(import.meta.url);
    const Database = requireFrom("better-sqlite3") as typeof import("better-sqlite3");
    const db = new Database(":memory:");
    db.exec("CREATE TABLE t (a INTEGER)");
    db.prepare("INSERT INTO t VALUES (1)").run();
    const row = db.prepare("SELECT a FROM t").get() as { a: number };
    db.close();
    if (row.a !== 1) throw new Error("sanity query returned the wrong value");
    return { name: "better-sqlite3 (native)", ok: true, fatal: true, detail: "loads and runs" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      name: "better-sqlite3 (native)",
      ok: false,
      fatal: true,
      detail: msg.split("\n")[0],
      fix:
        "The database engine could not load — this is almost always a Node version " +
        "mismatch. Run `npm rebuild better-sqlite3`. If that fails on Windows, install " +
        "the build tools: `npm install --global windows-build-tools` (as Administrator), " +
        "or reinstall Node.js LTS and run `npm ci` again.",
    };
  }
}

export function checkWritable(dir: string): Check {
  const probe = path.join(dir, ".revenueos-write-probe");
  try {
    mkdirSync(dir, { recursive: true });
    accessSync(dir, constants.W_OK);
    writeFileSync(probe, "ok");
    rmSync(probe, { force: true });
    return { name: `Writable: ${dir}`, ok: true, fatal: true, detail: "writable" };
  } catch (err) {
    return {
      name: `Writable: ${dir}`,
      ok: false,
      fatal: true,
      detail: err instanceof Error ? err.message : String(err),
      fix:
        `RevenueOS keeps the books in this folder and cannot start without writing to it. ` +
        `Check the folder permissions, and make sure the app is not installed under ` +
        `Program Files (Windows restricts writes there).`,
    };
  }
}

export function checkDiskSpace(dir: string, minBytes: number = MIN_FREE_BYTES): Check {
  try {
    const s = statfsSync(dir);
    const free = s.bavail * s.bsize;
    const gb = (n: number) => `${(n / 1024 ** 3).toFixed(1)} GB`;
    const ok = free >= minBytes;
    return {
      name: "Disk space",
      ok,
      fatal: false,
      detail: `${gb(free)} free (want ${gb(minBytes)}+)`,
      fix: ok ? undefined : "Free some space — backups accumulate and will start failing.",
    };
  } catch (err) {
    return {
      name: "Disk space",
      ok: false,
      fatal: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

export function checkPortFree(port: number = APP_PORT): Promise<Check> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", (err: NodeJS.ErrnoException) => {
      resolve({
        name: `Port ${port}`,
        ok: false,
        fatal: false,
        detail: err.code === "EADDRINUSE" ? "already in use" : String(err.code ?? err.message),
        fix:
          `Something is already listening on ${port}. If RevenueOS is already running, ` +
          `that is fine — close this and use the running one. Otherwise stop the other ` +
          `program, or set PORT to a free number.`,
      });
    });
    server.once("listening", () => server.close(() => {
      resolve({ name: `Port ${port}`, ok: true, fatal: false, detail: "free" });
    }));
    server.listen(port, "127.0.0.1");
  });
}

/**
 * The `claude` CLI is the app's ONLY vision/LLM transport, billed to whoever is
 * logged in ON THIS MACHINE. On the client's copy that must be the CLIENT's own
 * subscription.
 *
 * Presence is checkable cheaply. Authentication is NOT — proving it costs a
 * real request, so this reports honestly that it verified presence only, and
 * tells the operator how to confirm the rest. Overstating this would surface as
 * a cryptic extraction failure on the first ledger photo, which is the worst
 * possible moment.
 */
export function checkClaudeCli(runner = spawnSync): Check {
  try {
    const res = runner("claude", ["--version"], { encoding: "utf8", timeout: 20_000 });
    if (res.error || res.status !== 0) {
      return {
        name: "claude CLI",
        ok: false,
        fatal: false,
        detail: res.error ? String(res.error.message).split("\n")[0] : `exited ${res.status}`,
        fix:
          "Photo extraction needs the Claude CLI signed in ON THIS MACHINE, with the " +
          "office's own Claude subscription. Install it, then run `claude login`. " +
          "Everything else (manual vouchers, Excel and Tally imports, all reports and " +
          "the CA pack) works without it.",
      };
    }
    return {
      name: "claude CLI",
      ok: true,
      fatal: false,
      detail: `${String(res.stdout).trim() || "present"} — presence only, sign-in NOT verified`,
      fix:
        "Confirm it is signed in to the OFFICE's account before the first ledger photo: " +
        "run `claude login` and check the account shown is theirs, not the installer's.",
    };
  } catch (err) {
    return {
      name: "claude CLI",
      ok: false,
      fatal: false,
      detail: err instanceof Error ? err.message : String(err),
      fix: "Install the Claude CLI and run `claude login`.",
    };
  }
}

export interface Summary {
  ok: boolean;
  fatalFailures: Check[];
  warnings: Check[];
}

export function summarize(checks: Check[]): Summary {
  const failed = checks.filter((c) => !c.ok);
  const fatalFailures = failed.filter((c) => c.fatal);
  return { ok: fatalFailures.length === 0, fatalFailures, warnings: failed.filter((c) => !c.fatal) };
}

export function formatCheck(c: Check): string {
  const mark = c.ok ? "✓" : c.fatal ? "✗" : "!";
  return `  ${mark} ${c.name}: ${c.detail}`;
}
