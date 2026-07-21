// NOTE: the Next docs open these files with `import "server-only"`. That is a
// separate npm package and is NOT installed here — adding it would break the
// build, and this repo keeps its dependency surface deliberately tiny
// (fast-xml-parser was RVOS-002's only new dep). The practical guard is that
// `next/headers` and better-sqlite3 both fail loudly if pulled into a client
// bundle, so a mistaken client import cannot silently succeed.
import { cookies } from "next/headers";
import { SESSION_COOKIE, SESSION_TTL_MS } from "./auth";

/**
 * Session cookie I/O — RVOS-003 P2.
 *
 * Next 16: `cookies()` is ASYNC and must be awaited (same rule as params /
 * searchParams — see AGENTS.md). Cookies are set on the server only; a
 * client-set cookie would be tamperable.
 *
 * ── The `secure` flag is the trap on this deployment ──
 * The Next docs' example hardcodes `secure: true`. That is correct for a site
 * on HTTPS and WRONG for us: the office reaches this over Tailscale as plain
 * `http://100.x.x.x:3322`, and a Secure cookie is silently DROPPED by the
 * browser on a non-HTTPS origin. The symptom would be a login form that
 * accepts the password, redirects, and lands back on the login page forever —
 * with nothing in the logs.
 *
 * So `secure` is opt-in via REVENUEOS_HTTPS=1, for whenever the office puts a
 * TLS terminator in front (`tailscale serve` does exactly this). Default off,
 * because the delivered configuration is plain HTTP on a private tailnet.
 */
const wantSecureCookie = (): boolean => process.env.REVENUEOS_HTTPS === "1";

export async function setSessionCookie(token: string, now: Date): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: wantSecureCookie(),
    sameSite: "lax",
    path: "/",
    expires: new Date(now.getTime() + SESSION_TTL_MS),
  });
}

export async function readSessionToken(): Promise<string | undefined> {
  const cookieStore = await cookies();
  return cookieStore.get(SESSION_COOKIE)?.value;
}

export async function clearSessionCookie(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete(SESSION_COOKIE);
}
