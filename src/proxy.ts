import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE } from "./lib/auth";

/**
 * Proxy — RVOS-003 P2.
 *
 * Next 16 renamed Middleware to Proxy; the file MUST be `src/proxy.ts`, beside
 * `app/`. There is no `middleware.ts` in this version.
 *
 * This is an OPTIMISTIC check only, per the Next docs: it looks at whether a
 * session cookie is PRESENT and nothing more. It deliberately does NOT open
 * the database — proxy runs on every request including prefetches, and a db
 * read here would put a query on every hovered link. Whether the cookie is
 * actually valid is decided by the DAL, at the data source (see lib/dal.ts).
 *
 * So: a forged cookie sails past this file and is rejected one layer down.
 * That is the intended design, not a gap — this layer exists to save a round
 * trip and to keep unauthenticated users out of the app shell, not to
 * authorize anything.
 *
 * DEFAULT-DENY: everything is protected unless it appears in PUBLIC_PATHS.
 * A new page is guarded the moment it exists, without anyone remembering to
 * add it to a list. That direction matters — an allowlist of protected routes
 * fails open on every route someone forgets.
 */

/** The only paths reachable without a session. Keep this list tiny. */
const PUBLIC_PATHS = ["/login"];

function isPublic(pathname: string): boolean {
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

export default function proxy(req: NextRequest): NextResponse {
  const { pathname, search } = req.nextUrl;
  const hasCookie = Boolean(req.cookies.get(SESSION_COOKIE)?.value);

  // Signed in and sitting on the login page — send them to the books.
  if (isPublic(pathname)) {
    if (hasCookie && pathname === "/login") {
      return NextResponse.redirect(new URL("/", req.nextUrl));
    }
    return NextResponse.next();
  }

  if (!hasCookie) {
    const url = new URL("/login", req.nextUrl);
    // Come back to where they were headed once they log in. Only the path is
    // carried, never an absolute URL — an attacker-supplied `next` pointing at
    // another origin would turn the login form into an open redirect.
    const target = `${pathname}${search}`;
    if (target !== "/") url.searchParams.set("next", target);
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

/**
 * Run on everything except Next's own static output and the favicon.
 *
 * `/api` is intentionally INSIDE the matcher, unlike the docs' sample. The
 * sample excludes it, which leaves route handlers with no proxy at all; here
 * they get the cheap cookie check too. That is belt-and-braces only — every
 * handler still calls requireApiSession(), because a matcher is one refactor
 * away from silently uncovering them.
 */
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
