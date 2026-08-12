import type Database from "better-sqlite3";
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { assertUsableCompany } from "./book";
import type { Role, AuthSessionRow, AuthUserRow } from "./types";

/**
 * Auth — RVOS-003 P2.
 *
 * Until now Tailscale WAS the perimeter: anything that could reach :3322 could
 * read the whole book. The office copy is reachable remotely, so that is no
 * longer defensible — this module is the perimeter, and Tailscale becomes
 * defence in depth behind it.
 *
 * Design notes, each of them load-bearing:
 *
 * - **Clock-free.** Every function takes `now` (ISO string), exactly like
 *   compliance.ts. A test can drive a lockout expiry or a session expiry
 *   without sleeping, and nothing here can behave differently on a machine
 *   whose clock drifts mid-request.
 * - **Only the token's HASH is stored.** The cookie holds 256 random bits; the
 *   db holds SHA-256 of it. Copying `data/revenueos.db` (which a backup, a
 *   Syncthing sync or a stolen laptop all do) therefore yields no usable
 *   session cookie. This is why sessions are a table and not a signed cookie:
 *   a signed cookie cannot be revoked, and "revoke access" is a thing an
 *   accounting office genuinely needs.
 * - **Lockout is persisted.** Counting failures in memory means restarting the
 *   server clears an attack in progress; on a machine that autostarts at logon
 *   that is not hypothetical.
 * - **Timing.** Password comparison is timingSafeEqual over fixed-length
 *   buffers. An unknown username still performs a scrypt against a dummy salt
 *   so that "no such user" and "wrong password" take the same time — otherwise
 *   the login form enumerates who works at the office.
 */

/** scrypt cost. 128 * N * r bytes ≈ 16 MB per hash — deliberate: it makes a
 * stolen-hash dictionary attack expensive while staying imperceptible on a
 * login that happens a few times a day. */
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 64;

/** Sliding session: each verified request pushes expiry out by this much. */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours
/** Failures before the account locks, and for how long. */
export const MAX_FAILED_ATTEMPTS = 5;
export const LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes

/** Name of the cookie carrying the session token. */
export const SESSION_COOKIE = "revenueos_session";

function scrypt(password: string, saltHex: string): string {
  return scryptSync(password.normalize("NFKC"), Buffer.from(saltHex, "hex"), KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  }).toString("hex");
}

export function hashPassword(password: string, saltHex?: string): {
  hash: string;
  salt: string;
} {
  const salt = saltHex ?? randomBytes(16).toString("hex");
  return { hash: scrypt(password, salt), salt };
}

/** Constant-time compare. Lengths are equal by construction (same KEY_LEN),
 * but a corrupt row must not throw its way into a truthy path — hence the
 * explicit length guard before timingSafeEqual, which throws on mismatch. */
export function verifyPassword(password: string, hash: string, salt: string): boolean {
  const computed = Buffer.from(scrypt(password, salt), "hex");
  const stored = Buffer.from(hash, "hex");
  if (computed.length !== stored.length || stored.length === 0) return false;
  return timingSafeEqual(computed, stored);
}

/** A password that would embarrass the office if it were the only thing
 * between the tailnet and the books. Deliberately modest — this is a local
 * app for a handful of known people, not a public signup form. */
export function passwordProblem(password: string): string | null {
  if (password.length < 10) return "Use at least 10 characters.";
  if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password))
    return "Use at least one letter and one number.";
  return null;
}

/** Sentinel origin for resolving a redirect target. `.invalid` is reserved by
 * RFC 2606 and can never be a real host. */
const SENTINEL_ORIGIN = "http://sentinel.invalid";

/**
 * Sanitise the post-login `next` target to a same-origin PATH.
 *
 * Lives here rather than in auth-actions.ts because a "use server" module may
 * only export async functions — and this needs to be directly testable.
 *
 * String-matching this is a trap. Rejecting only `//` looks sufficient and is
 * not: the WHATWG URL parser normalises a leading BACKSLASH to a slash, so
 * "/\evil.com" — which starts with "/" and not with "//" — resolves to
 * http://evil.com/. Since /login is public, that turns a link to our own real
 * login page into an open redirect that fires AFTER the victim has signed in
 * with genuine credentials.
 *
 * So: resolve against a sentinel origin and require that the result did not
 * leave it. Parsing beats pattern-matching for anything a browser will parse.
 */
export function safeNextPath(raw: unknown): string {
  if (typeof raw !== "string" || !raw.startsWith("/")) return "/";
  try {
    const url = new URL(raw, SENTINEL_ORIGIN);
    if (url.origin !== SENTINEL_ORIGIN) return "/";
    // Hash is dropped: it never reaches the server and cannot be trusted.
    return `${url.pathname}${url.search}`;
  } catch {
    return "/";
  }
}

export function createUser(
  db: Database.Database,
  username: string,
  password: string,
  now: string
): number {
  const name = username.trim();
  if (!name) throw new Error("Username required");
  const problem = passwordProblem(password);
  if (problem) throw new Error(problem);
  const { hash, salt } = hashPassword(password);
  const info = db
    .prepare(
      `INSERT INTO auth_users (username, password_hash, password_salt, created_at)
       VALUES (@username, @hash, @salt, @now)`
    )
    .run({ username: name, hash, salt, now });
  return Number(info.lastInsertRowid);
}

export function userCount(db: Database.Database): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM auth_users`).get() as { n: number };
  return row.n;
}

export type AuthOutcome =
  | { ok: true; user_id: number }
  | { ok: false; reason: "bad_credentials" | "locked"; locked_until?: string };

/**
 * Check a password and maintain the lockout counter.
 *
 * The dummy-scrypt branch matters: without it, an unknown username returns in
 * microseconds while a known one takes ~50ms, and the form becomes a staff
 * directory.
 */
export function authenticate(
  db: Database.Database,
  username: string,
  password: string,
  now: string
): AuthOutcome {
  const user = db
    .prepare(`SELECT * FROM auth_users WHERE username = @username`)
    .get({ username: username.trim() }) as AuthUserRow | undefined;

  if (!user) {
    // Equalise timing against the real path. Result is discarded.
    hashPassword(password, "00000000000000000000000000000000");
    return { ok: false, reason: "bad_credentials" };
  }

  if (user.locked_until && user.locked_until > now) {
    return { ok: false, reason: "locked", locked_until: user.locked_until };
  }

  if (!verifyPassword(password, user.password_hash, user.password_salt)) {
    const failed = user.failed_attempts + 1;
    const lock =
      failed >= MAX_FAILED_ATTEMPTS
        ? new Date(new Date(now).getTime() + LOCKOUT_MS).toISOString()
        : null;
    db.prepare(
      `UPDATE auth_users SET failed_attempts = @failed, locked_until = @lock WHERE id = @id`
    ).run({ failed, lock, id: user.id });
    return lock
      ? { ok: false, reason: "locked", locked_until: lock }
      : { ok: false, reason: "bad_credentials" };
  }

  db.prepare(
    `UPDATE auth_users SET failed_attempts = 0, locked_until = NULL, last_login_at = @now
     WHERE id = @id`
  ).run({ now, id: user.id });
  return { ok: true, user_id: user.id };
}

/** Mint a session. Returns the RAW token — the only time it exists in
 * plaintext. The caller puts it in an httpOnly cookie; the db never sees it. */
export function createSession(
  db: Database.Database,
  userId: number,
  now: string
): string {
  const token = randomBytes(32).toString("hex");
  const expires = new Date(new Date(now).getTime() + SESSION_TTL_MS).toISOString();
  db.prepare(
    `INSERT INTO auth_sessions (token_sha256, user_id, created_at, expires_at, last_seen_at)
     VALUES (@sha, @user_id, @now, @expires, @now)`
  ).run({ sha: sha256(token), user_id: userId, now, expires });
  return token;
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export interface SessionUser {
  user_id: number;
  username: string;
  /** What this login may do (RVOS-006 P0b). Resolved on every session lookup
   * rather than stored on the session, so a demotion binds immediately. */
  role: Role;
  /** The book this login is currently looking at. NULL = none chosen yet —
   * a real, expected state for a fresh login, not an error (RVOS-004 P3). */
  companyId: number | null;
}

/**
 * Resolve a raw cookie token to a user, sliding the expiry forward.
 *
 * Returns null for absent, unknown, or EXPIRED tokens — an expired row is
 * deleted on sight rather than left to a sweep, so a session cannot be
 * resurrected by a clock that moves backwards.
 */
export function lookupSession(
  db: Database.Database,
  token: string | undefined,
  now: string
): SessionUser | null {
  if (!token) return null;
  const sha = sha256(token);
  const row = db
    .prepare(
      `SELECT s.*, u.username AS username, u.role AS role
         FROM auth_sessions s JOIN auth_users u ON u.id = s.user_id
        WHERE s.token_sha256 = @sha`
    )
    .get({ sha }) as (AuthSessionRow & { username: string; role: Role }) | undefined;
  if (!row) return null;

  if (row.expires_at <= now) {
    db.prepare(`DELETE FROM auth_sessions WHERE token_sha256 = @sha`).run({ sha });
    return null;
  }

  const expires = new Date(new Date(now).getTime() + SESSION_TTL_MS).toISOString();
  db.prepare(
    `UPDATE auth_sessions SET last_seen_at = @now, expires_at = @expires
      WHERE token_sha256 = @sha`
  ).run({ now, expires, sha });

  return {
    user_id: row.user_id,
    username: row.username,
    // Read fresh on every session lookup, never cached on the session row: a
    // role change (or a demotion) must take effect on the user's next request,
    // not whenever they happen to sign in again.
    role: row.role,
    companyId: row.company_id,
  };
}

/**
 * Point a session at a company. This is the ONE place a company id is
 * accepted as an argument outside a query already scoped by the session
 * (RVOS-004 T2) — and it is a deliberate, narrow exception, not a hole in
 * that rule: T2 forbids trusting a caller-supplied id to scope a READ or
 * WRITE of book data; it says nothing about identifying WHICH book to make
 * active, which has to come from somewhere. What keeps this exception safe:
 *
 *   1. it requires an authenticated session (the caller can only ever move
 *      ITS OWN session, never anyone else's — token is unguessable and
 *      server-held);
 *   2. `assertUsableCompany` proves the target exists and is not archived
 *      BEFORE anything is written; and
 *   3. it never serves data back — it only ever mutates this one session
 *      row. No report, export, or voucher accepts a company id this way.
 *
 * Throws (does not silently no-op) on an unknown token, so a caller cannot
 * mistake a stale cookie for a successful switch.
 */
export function setSessionCompany(
  db: Database.Database,
  token: string | undefined,
  companyId: number
): void {
  if (!token) throw new Error("No session.");
  assertUsableCompany(db, companyId);
  const info = db
    .prepare(`UPDATE auth_sessions SET company_id = @companyId WHERE token_sha256 = @sha`)
    .run({ companyId, sha: sha256(token) });
  if (info.changes === 0) throw new Error("No such session.");
}

export function destroySession(db: Database.Database, token: string | undefined): void {
  if (!token) return;
  db.prepare(`DELETE FROM auth_sessions WHERE token_sha256 = @sha`).run({
    sha: sha256(token),
  });
}

/** Drop every session for a user — "sign out everywhere", and what a password
 * change must do, or the old cookie outlives the password it was issued for. */
export function destroyUserSessions(db: Database.Database, userId: number): void {
  db.prepare(`DELETE FROM auth_sessions WHERE user_id = @user_id`).run({ user_id: userId });
}

export function purgeExpiredSessions(db: Database.Database, now: string): number {
  const info = db
    .prepare(`DELETE FROM auth_sessions WHERE expires_at <= @now`)
    .run({ now });
  return info.changes;
}

export function changePassword(
  db: Database.Database,
  userId: number,
  password: string
): void {
  const problem = passwordProblem(password);
  if (problem) throw new Error(problem);
  const { hash, salt } = hashPassword(password);
  db.prepare(
    `UPDATE auth_users SET password_hash = @hash, password_salt = @salt,
            failed_attempts = 0, locked_until = NULL
      WHERE id = @id`
  ).run({ hash, salt, id: userId });
  // A changed password must not leave old cookies working.
  destroyUserSessions(db, userId);
}
