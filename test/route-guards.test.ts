import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * Route-guard enumeration — RVOS-003 P2.
 *
 * Every other auth test proves the MECHANISM works. This one proves it is
 * actually ATTACHED, everywhere, and keeps proving it for routes nobody has
 * written yet. It walks the router the way Next does — by file convention —
 * rather than checking a hand-maintained list, because a hand-maintained list
 * is exactly what goes stale the day someone adds a page in a hurry.
 *
 * This is a STATIC check: it reads source text. It cannot prove the guard runs
 * first at runtime (the unit tests and the qa-runner drive cover that). What it
 * does prove is that no route exists WITHOUT one — which is the failure mode
 * that actually happens, because it happens by omission rather than by error.
 *
 * Deliberately hardcoded and small: PUBLIC_PAGES is the allowlist, and adding
 * to it should feel heavier than adding a guard.
 */

const APP_DIR = path.join(process.cwd(), "src", "app");

/** The only pages permitted to render without a session. */
const PUBLIC_PAGES = new Set(["login/page.tsx"]);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const files = walk(APP_DIR);
const rel = (f: string) => path.relative(APP_DIR, f).split(path.sep).join("/");

const pages = files.filter((f) => f.endsWith("page.tsx"));
const handlers = files.filter((f) => f.endsWith("route.ts"));

test("the router has the pages and handlers we think it has", () => {
  // A canary: if these counts move, a route was added or removed, and the
  // assertions below deserve a fresh look rather than a silent pass.
  assert.ok(pages.length >= 22, `expected >= 22 pages, found ${pages.length}`);
  assert.ok(handlers.length >= 7, `expected >= 7 route handlers, found ${handlers.length}`);
});

test("EVERY page requires a session, except the declared public ones", () => {
  const unguarded: string[] = [];
  for (const file of pages) {
    const name = rel(file);
    const src = readFileSync(file, "utf8");
    // requireBook() (RVOS-004 P3) internally calls requireSession() but a
    // page that switched to it ONLY won't say "requireSession()" in its own
    // source — see HANDOFF.md's gotcha on this exact test. Either guard
    // proves a session is required; requireBook() additionally requires an
    // active company.
    //
    // Match the CALL, not one exact arity: since RVOS-006 P0b requireBook
    // takes an optional capability, so `requireBook("users.manage")` is still
    // a guard. A detector that insisted on empty parens reported two correctly
    // guarded pages as unguarded — a false alarm that, believed, would have
    // sent someone to "fix" pages that were already safe.
    const guarded =
        /require(?:Session|Book)\s*\(/.test(src);
    if (PUBLIC_PAGES.has(name)) {
      assert.equal(
        guarded,
        false,
        `${name} is declared public but guards itself — the app would be unreachable`
      );
      continue;
    }
    if (!guarded) unguarded.push(name);
  }
  assert.deepEqual(unguarded, [], `these pages render without an auth check: ${unguarded}`);
});

test("EVERY route handler returns 401 rather than redirecting", () => {
  const unguarded: string[] = [];
  for (const file of handlers) {
    const src = readFileSync(file, "utf8");
    // requireApiBook() (RVOS-004 P4) is requireApiSession()'s counterpart for
    // handlers that also need an active company — it still answers with a
    // Response (401/409), never a redirect. See requireApiSession() below.
    if (!/requireApi(?:Session|Book)\s*\(/.test(src)) {
      unguarded.push(rel(file));
    }
  }
  assert.deepEqual(
    unguarded,
    [],
    `these API routes are open: ${unguarded}. An API caller needs a status code, ` +
      `not an HTML redirect — use requireApiSession() or requireApiBook(), not requireSession()/requireBook().`
  );
});

test("no page is statically rendered — a DAL cannot protect build-time data", () => {
  // The Next docs are explicit that a Data Access Layer does not protect a
  // static route: its data is fetched at build time, not per request. A page
  // that loses force-dynamic silently stops being protected by its own guard.
  const staticPages: string[] = [];
  for (const file of pages) {
    const src = readFileSync(file, "utf8");
    if (!src.includes('export const dynamic = "force-dynamic"')) staticPages.push(rel(file));
  }
  assert.deepEqual(staticPages, [], `these pages render statically: ${staticPages}`);
});

test("pages do not use the Api guards, and handlers do not use the page guards", () => {
  // Crossing these over fails quietly in opposite directions: a page returning
  // a bare 401 Response renders nothing useful, and an API route throwing a
  // redirect answers a fetch() with an HTML login page and a 200-shaped hop.
  for (const file of pages) {
    if (PUBLIC_PAGES.has(rel(file))) continue;
    const src = readFileSync(file, "utf8");
    assert.equal(
      src.includes("requireApiSession") || src.includes("requireApiBook"),
      false,
      `${rel(file)} is a page and must use requireSession() or requireBook()`
    );
  }
  for (const file of handlers) {
    const src = readFileSync(file, "utf8");
    assert.equal(
      src.includes("requireSession()") || src.includes("requireBook()"),
      false,
      `${rel(file)} is a route handler and must use requireApiSession() or requireApiBook()`
    );
  }
});

test("the proxy's public allowlist stays tiny and is default-deny", () => {
  const proxy = readFileSync(path.join(process.cwd(), "src", "proxy.ts"), "utf8");
  assert.ok(
    proxy.includes('const PUBLIC_PATHS = ["/login"]'),
    "PUBLIC_PATHS changed — every addition is a route reachable with no cookie at all"
  );
  // The matcher must not exclude /api. The Next docs' sample does exclude it,
  // which would leave route handlers with no proxy layer whatsoever.
  assert.equal(
    proxy.includes("?!api"),
    false,
    "the proxy matcher excludes /api — handlers would lose their cheap cookie check"
  );
});

test("every server action in actions.ts is guarded", () => {
  const src = readFileSync(path.join(process.cwd(), "src", "lib", "actions.ts"), "utf8");
  const exported = [...src.matchAll(/export async function (\w+)/g)].map((m) => m[1]);
  assert.ok(exported.length >= 20, `expected >= 20 actions, found ${exported.length}`);

  // Server Functions are POSTs to whatever route uses them, so the proxy never
  // dependably covers them: each one is its own boundary. requireBook()
  // (RVOS-004 P3) is also a valid guard — it requires a session AND an
  // active company, a strict superset of requireSession() alone.
  const guards = [...src.matchAll(/await require(?:Session|Book)\(/g)].length;
  assert.equal(
    guards,
    exported.length,
    `${exported.length} exported actions but ${guards} guards — one is unprotected`
  );
});

/**
 * A ratchet, not a style rule — RVOS-006 P0b.
 *
 * `requireBook()` defaults to `book.read` so that the many display-only PAGES
 * did not all have to be edited when capabilities landed. That default is
 * exactly wrong for a server action: every action here MUTATES something, so an
 * action that forgets its capability would be authorized for any signed-in
 * user, including a `viewer`, and would look guarded while being wide open.
 *
 * So inside actions.ts every requireBook must name a capability. This is the
 * same shape as the tenancy ratchet in book.ts: make the omission a loud
 * failure in a test rather than a silent grant in production.
 */
test("no server action falls back to the read-only capability default", () => {
  const src = readFileSync(path.join(process.cwd(), "src", "lib", "actions.ts"), "utf8");
  const bare = [...src.matchAll(/await requireBook\(\s*\)/g)].length;
  assert.equal(
    bare,
    0,
    `${bare} action(s) call requireBook() with no capability — a mutating action ` +
      `must name what it needs, or a viewer is authorized to perform it`
  );
});

/**
 * A ratchet against the defect found in RVOS-006 P0b's cleanup.
 *
 * `createTdsChallan` built its bank leg with a literal `account_code: "1100"`,
 * which survived P0a's sweep because P0a replaced the `settle_account` ENUM and
 * this code never used the enum — it named the ledger directly. The result was
 * a book where every TDS deposit appeared to leave the first bank account no
 * matter which one it came from, defeating the reconciliation P0a exists to
 * make possible.
 *
 * A settlement leg must resolve its ledger from a `bank_account_id`, never name
 * 1000/1100 inline. Seeding and chart-of-accounts metadata legitimately mention
 * those codes, so this is scoped to leg construction specifically.
 */
test("no voucher leg hardcodes a settlement ledger", () => {
  const src = readFileSync(path.join(process.cwd(), "src", "lib", "actions.ts"), "utf8");
  const offenders = [...src.matchAll(/account_code:\s*"(1000|1100)"/g)].map((m) => m[1]);
  assert.deepEqual(
    offenders,
    [],
    `a leg names ledger ${offenders.join(", ")} directly — resolve it from a ` +
      `bank_account_id via resolveSettleCode, or a multi-account book cannot reconcile`
  );
});
