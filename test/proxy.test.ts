import { strict as assert } from "node:assert";
import { test } from "node:test";
import { NextRequest } from "next/server";
import proxy from "../src/proxy";
import { SESSION_COOKIE } from "../src/lib/auth";

/**
 * Proxy behaviour — RVOS-003 P2.
 *
 * These exist because `route-guards.test.ts` structurally cannot cover this.
 * That test is STATIC: it reads source text and proves every handler calls
 * requireApiSession(). It cannot prove the request ever REACHES the handler —
 * and it did not. The proxy runs first, and on a missing cookie it redirected
 * everything, including /api, so each handler's 401 was being rewritten into a
 * 307 that no fetch() or curl could act on. The qa-runner drive caught it.
 *
 * So: exercise the proxy function directly, with real NextRequest objects.
 * Cheap, and it closes the gap between "the guard exists" and "the guard runs".
 */

function get(path: string, opts: { cookie?: boolean } = {}): NextRequest {
  const req = new NextRequest(new URL(path, "http://localhost:3322"));
  if (opts.cookie) req.cookies.set(SESSION_COOKIE, "a".repeat(64));
  return req;
}

test("an anonymous API request gets 401, NOT a redirect", () => {
  for (const path of [
    "/api/export/trial-balance?format=csv",
    "/api/export/day-book",
    "/api/import/template",
    "/api/uploads/1",
    "/api/upload",
  ]) {
    const res = proxy(get(path));
    assert.equal(res.status, 401, `${path} must answer with a status code`);
    assert.equal(
      res.headers.get("location"),
      null,
      `${path} must not redirect — a script cannot act on an HTML login page`
    );
  }
});

test("an anonymous page request redirects to /login carrying its target", () => {
  const res = proxy(get("/reports/trial-balance"));
  assert.equal(res.status, 307);
  const loc = new URL(res.headers.get("location")!);
  assert.equal(loc.pathname, "/login");
  assert.equal(loc.searchParams.get("next"), "/reports/trial-balance");
});

test("the query string survives the round trip to /login", () => {
  const res = proxy(get("/reports/gst?month=2026-04"));
  const loc = new URL(res.headers.get("location")!);
  assert.equal(loc.searchParams.get("next"), "/reports/gst?month=2026-04");
});

test("the root is not echoed back as a next target", () => {
  const res = proxy(get("/"));
  const loc = new URL(res.headers.get("location")!);
  assert.equal(loc.pathname, "/login");
  assert.equal(loc.searchParams.get("next"), null, "next=/ is noise");
});

test("/login is reachable with no cookie", () => {
  const res = proxy(get("/login"));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("location"), null);
});

test("a signed-in user is bounced off /login", () => {
  const res = proxy(get("/login", { cookie: true }));
  assert.equal(res.status, 307);
  assert.equal(new URL(res.headers.get("location")!).pathname, "/");
});

test("a cookie-bearing request passes through untouched", () => {
  // The proxy is OPTIMISTIC: presence is all it checks. Whether the cookie is
  // real is the DAL's decision, at the data source. A forged cookie is
  // SUPPOSED to reach the app and be rejected one layer down.
  for (const path of ["/", "/vouchers", "/api/export/day-book", "/pack?fy=2026-27"]) {
    const res = proxy(get(path, { cookie: true }));
    assert.equal(res.status, 200, `${path} should pass through`);
    assert.equal(res.headers.get("location"), null);
  }
});
