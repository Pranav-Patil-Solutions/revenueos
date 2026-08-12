// See the note in session.ts: `server-only` is not a dependency of this repo.
import { cache } from "react";
import { redirect } from "next/navigation";
import { NextResponse } from "next/server";
import { assertUsableCompany, book, type Book } from "./book";
import { getDb } from "./db";
import { lookupSession, type SessionUser } from "./auth";
import { can, refusalMessage } from "./roles";
import { readSessionToken } from "./session";
import type { Capability } from "./types";

/**
 * Data Access Layer — the REAL authorization boundary (RVOS-003 P2).
 *
 * Why this exists rather than "the proxy handles it":
 *
 * - The Next 16 docs are explicit that Proxy "should not be your only line of
 *   defense" and must do optimistic, cookie-only checks — no db reads, because
 *   it runs on every request including PREFETCHES.
 * - Server Functions are NOT separate routes: they are POSTs to the route that
 *   uses them, so a proxy matcher that skips a path also skips every action on
 *   it. Moving an action to another route can silently remove proxy coverage.
 *   Every action therefore checks for itself.
 * - The recommended matcher excludes `/api`, so route handlers get NO proxy
 *   protection whatsoever. Their in-handler check is the only defence.
 * - Layouts do NOT protect nested routes — Partial Rendering means a layout
 *   does not re-render on navigation, so a session check there is not run on
 *   every route change. Checks live per page, not in the layout.
 *
 * `cache()` dedupes the session lookup within a single render pass, so a page
 * plus its data fetchers hit the db once, not once per call.
 */

/** Resolve the current user, or null. Never redirects — callers decide.
 * Sliding expiry is applied by lookupSession as a side effect of a hit. */
export const getSessionUser = cache(async (): Promise<SessionUser | null> => {
  const token = await readSessionToken();
  if (!token) return null;
  return lookupSession(getDb(), token, new Date().toISOString());
});

/**
 * Assert a session for a PAGE or SERVER ACTION. Redirects to /login when
 * absent — `redirect()` throws, so control never returns to the caller and
 * the guard cannot be accidentally fallen through.
 */
export async function requireSession(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  return user;
}

/**
 * Assert a session for a ROUTE HANDLER. Returns the user, or a 401 Response to
 * return as-is — an API caller wants a status code, not an HTML redirect.
 *
 *   const gate = await requireApiSession();
 *   if (gate instanceof Response) return gate;
 */
export async function requireApiSession(): Promise<SessionUser | Response> {
  const user = await getSessionUser();
  if (!user) return new Response(null, { status: 401 });
  return user;
}

/**
 * Assert a session AND an active, usable company — for pages and actions
 * that read or write book data (RVOS-004 P3). Redirects to /companies when
 * none is selected, or when the one on the session was archived or deleted
 * out from under it since it was chosen — `assertUsableCompany` re-checks
 * every call rather than trusting a value cached on the session row, so an
 * archive mid-session self-heals to the picker instead of quietly reading a
 * dead company's empty book.
 *
 * Returns a Book bound to `getDb()` fresh on every call (not memoised): the
 * Next docs' `cache()` dedupe is per-REQUEST, and a company switch happens
 * on its own request, so there is no stale-handle window to guard against —
 * but a handle is cheap to construct and holding one across requests would
 * be the mistake, so this deliberately does not use `cache()` itself.
 */
export async function requireBook(
  capability: Capability = "book.read"
): Promise<{ user: SessionUser; book: Book }> {
  const user = await requireSession();
  if (user.companyId == null) redirect("/companies");
  const db = getDb();
  let usable = true;
  try {
    assertUsableCompany(db, user.companyId);
  } catch {
    usable = false;
  }
  if (!usable) redirect("/companies");

  // Capability check AFTER the company is known to be usable, so a refusal
  // always means "you may not do this", never "your company vanished".
  //
  // Defaults to `book.read` so every existing page that just displays data
  // keeps working unchanged; the sensitive actions name their capability
  // explicitly. A throw (not a redirect) because these are Server Actions as
  // often as pages, and silently redirecting a POST would look to the caller
  // like the action had succeeded.
  assertCan(user, capability);

  return { user, book: book(db, user.companyId, user.user_id) };
}

/**
 * Refuse unless the role holds the capability. Exported so a page can gate a
 * BUTTON on the same rule that gates the action behind it — the two must not
 * drift, or the UI offers something the server will reject.
 */
export function assertCan(user: SessionUser, capability: Capability): void {
  if (!can(user.role, capability)) {
    throw new Error(refusalMessage(user.role, capability));
  }
}

/** Non-throwing form, for deciding whether to render a control. */
export function userCan(user: SessionUser, capability: Capability): boolean {
  return can(user.role, capability);
}

/**
 * Assert a session AND an active, usable company for a ROUTE HANDLER —
 * requireBook's counterpart for API callers (RVOS-004 P4), same reasoning as
 * requireApiSession vs requireSession: an API caller (the import routes) wants
 * a status code it can check with `res.ok`, never requireBook's HTML redirect
 * to /companies, which would answer a `fetch()` with a 307 to a login-shaped
 * page instead of the JSON error the client expects.
 *
 *   const gate = await requireApiBook();
 *   if (gate instanceof Response) return gate;
 */
export async function requireApiBook(
  capability: Capability = "book.read"
): Promise<{ user: SessionUser; book: Book } | Response> {
  const gate = await requireApiSession();
  if (gate instanceof Response) return gate;
  if (gate.companyId == null) {
    return NextResponse.json(
      { error: "No company is active — choose one at /companies first." },
      { status: 409 }
    );
  }
  const db = getDb();
  try {
    assertUsableCompany(db, gate.companyId);
  } catch {
    return NextResponse.json(
      { error: "The active company is no longer available — choose one at /companies." },
      { status: 409 }
    );
  }
  if (!can(gate.role, capability)) {
    // 403, not 401: the caller IS authenticated, they simply may not do this.
    return NextResponse.json(
      { error: refusalMessage(gate.role, capability) },
      { status: 403 }
    );
  }
  return { user: gate, book: book(db, gate.companyId, gate.user_id) };
}
