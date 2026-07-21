// See the note in session.ts: `server-only` is not a dependency of this repo.
import { cache } from "react";
import { redirect } from "next/navigation";
import { getDb } from "./db";
import { lookupSession, type SessionUser } from "./auth";
import { readSessionToken } from "./session";

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
