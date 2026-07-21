import { strict as assert } from "node:assert";
import { test } from "node:test";
import Database from "better-sqlite3";
import { initSchema, seedCoreData } from "../src/lib/db";
import type { AuthOutcome } from "../src/lib/auth";
import {
  authenticate,
  changePassword,
  createSession,
  createUser,
  destroySession,
  destroyUserSessions,
  hashPassword,
  LOCKOUT_MS,
  lookupSession,
  MAX_FAILED_ATTEMPTS,
  passwordProblem,
  purgeExpiredSessions,
  SESSION_TTL_MS,
  userCount,
  verifyPassword,
} from "../src/lib/auth";

/**
 * Auth tests — RVOS-003 P2.
 *
 * Every function under test takes `now`, so lockout windows and session
 * expiries are driven by arithmetic rather than by sleeping. A test that
 * sleeps 15 minutes does not get written, and therefore does not get run.
 */

const PW = "correct-horse-9";
const T0 = "2026-07-21T09:00:00.000Z";

function at(offsetMs: number): string {
  return new Date(new Date(T0).getTime() + offsetMs).toISOString();
}

function authDb(): Database.Database {
  const db = new Database(":memory:");
  initSchema(db);
  seedCoreData(db);
  return db;
}

function withUser(): { db: Database.Database; id: number } {
  const db = authDb();
  const id = createUser(db, "pranav", PW, T0);
  return { db, id };
}

/** Assert an outcome failed and hand back the NARROWED failure arm.
 * `assert.equal(o.ok, false)` does not narrow a discriminated union for the
 * type checker, so reading `.reason` off the raw outcome does not compile. */
function failed(outcome: AuthOutcome): Extract<AuthOutcome, { ok: false }> {
  if (outcome.ok) {
    assert.fail(`expected a failed authentication, got user_id ${outcome.user_id}`);
  }
  return outcome;
}

// ── hashing ──────────────────────────────────────────────────────────────

test("password hashing round-trips and rejects the wrong password", () => {
  const { hash, salt } = hashPassword(PW);
  assert.equal(verifyPassword(PW, hash, salt), true);
  assert.equal(verifyPassword("correct-horse-8", hash, salt), false);
  assert.equal(verifyPassword("", hash, salt), false);
});

test("the same password hashes differently under different salts", () => {
  const a = hashPassword(PW);
  const b = hashPassword(PW);
  assert.notEqual(a.salt, b.salt);
  assert.notEqual(a.hash, b.hash, "a shared salt would make the hashes rainbow-tableable");
});

test("a corrupt or empty stored hash is rejected, not thrown on", () => {
  const { salt } = hashPassword(PW);
  // timingSafeEqual THROWS on a length mismatch — the guard must catch that
  // before it can become an exception on the login path.
  assert.equal(verifyPassword(PW, "", salt), false);
  assert.equal(verifyPassword(PW, "abcd", salt), false);
});

test("passwordProblem enforces length and a letter+digit", () => {
  assert.ok(passwordProblem("short1"));
  assert.ok(passwordProblem("alllettershere"));
  assert.ok(passwordProblem("1234567890"));
  assert.equal(passwordProblem(PW), null);
});

test("createUser refuses a password that fails the policy", () => {
  const db = authDb();
  assert.throws(() => createUser(db, "x", "weak", T0));
  assert.equal(userCount(db), 0, "a rejected password must not leave a user row");
});

// ── authenticate ─────────────────────────────────────────────────────────

test("authenticate accepts the right password and rejects the wrong one", () => {
  const { db, id } = withUser();
  assert.deepEqual(authenticate(db, "pranav", PW, T0), { ok: true, user_id: id });
  assert.deepEqual(authenticate(db, "pranav", "nope-12345", T0), {
    ok: false,
    reason: "bad_credentials",
  });
});

test("username matching is case-insensitive", () => {
  const { db, id } = withUser();
  assert.deepEqual(authenticate(db, "PRANAV", PW, T0), { ok: true, user_id: id });
  assert.deepEqual(authenticate(db, "  pranav  ".trim(), PW, T0), { ok: true, user_id: id });
});

test("an unknown username is indistinguishable from a wrong password", () => {
  const { db } = withUser();
  const unknown = authenticate(db, "nobody", PW, T0);
  const wrong = authenticate(db, "pranav", "nope-12345", T0);
  assert.deepEqual(unknown, wrong, "differing shapes would let the form enumerate staff");
});

test("lockout trips at MAX_FAILED_ATTEMPTS and blocks even the CORRECT password", () => {
  const { db } = withUser();
  for (let i = 1; i < MAX_FAILED_ATTEMPTS; i++) {
    assert.equal(failed(authenticate(db, "pranav", "wrong-12345", T0)).reason, "bad_credentials");
  }
  const tripped = failed(authenticate(db, "pranav", "wrong-12345", T0));
  assert.equal(tripped.reason, "locked");

  // The whole point: a locked account does not open for the right password.
  const rightButLocked = failed(authenticate(db, "pranav", PW, T0));
  assert.equal(rightButLocked.reason, "locked");
});

test("the lockout expires on its own clock", () => {
  const { db, id } = withUser();
  for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) {
    authenticate(db, "pranav", "wrong-12345", T0);
  }
  assert.equal(authenticate(db, "pranav", PW, at(LOCKOUT_MS - 1000)).ok, false);
  assert.deepEqual(authenticate(db, "pranav", PW, at(LOCKOUT_MS + 1000)), {
    ok: true,
    user_id: id,
  });
});

test("lockout state survives a restart — it is in the db, not in memory", () => {
  const { db } = withUser();
  for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) {
    authenticate(db, "pranav", "wrong-12345", T0);
  }
  const row = db.prepare("SELECT failed_attempts, locked_until FROM auth_users").get() as {
    failed_attempts: number;
    locked_until: string | null;
  };
  assert.equal(row.failed_attempts, MAX_FAILED_ATTEMPTS);
  assert.ok(row.locked_until, "an in-memory counter would be cleared by autostart-at-logon");
});

test("a successful login clears the failure counter", () => {
  const { db } = withUser();
  authenticate(db, "pranav", "wrong-12345", T0);
  authenticate(db, "pranav", "wrong-12345", T0);
  authenticate(db, "pranav", PW, T0);
  const row = db.prepare("SELECT failed_attempts, last_login_at FROM auth_users").get() as {
    failed_attempts: number;
    last_login_at: string | null;
  };
  assert.equal(row.failed_attempts, 0);
  assert.equal(row.last_login_at, T0);
});

// ── sessions ─────────────────────────────────────────────────────────────

test("a session resolves to its user", () => {
  const { db, id } = withUser();
  const token = createSession(db, id, T0);
  assert.deepEqual(lookupSession(db, token, T0), { user_id: id, username: "pranav" });
});

test("the RAW token is never stored — a copied db yields no usable cookie", () => {
  const { db, id } = withUser();
  const token = createSession(db, id, T0);
  const rows = db.prepare("SELECT * FROM auth_sessions").all();
  const dump = JSON.stringify(rows);
  assert.equal(
    dump.includes(token),
    false,
    "the cookie value must not be recoverable from the database file"
  );
  assert.ok(dump.length > 0);
});

test("an absent or unknown token resolves to nothing", () => {
  const { db } = withUser();
  assert.equal(lookupSession(db, undefined, T0), null);
  assert.equal(lookupSession(db, "deadbeef", T0), null);
});

test("an expired session is refused AND deleted on sight", () => {
  const { db, id } = withUser();
  const token = createSession(db, id, T0);
  assert.equal(lookupSession(db, token, at(SESSION_TTL_MS + 1)), null);
  const left = db.prepare("SELECT COUNT(*) AS n FROM auth_sessions").get() as { n: number };
  assert.equal(left.n, 0, "an expired row left behind could be revived by a backwards clock");
});

test("activity slides the expiry forward", () => {
  const { db, id } = withUser();
  const token = createSession(db, id, T0);
  const mid = at(SESSION_TTL_MS / 2);
  assert.ok(lookupSession(db, token, mid));
  // Without sliding renewal this would be expired; with it, it is still live.
  const late = at(SESSION_TTL_MS + SESSION_TTL_MS / 4);
  assert.deepEqual(lookupSession(db, token, late), { user_id: id, username: "pranav" });
});

test("logout destroys exactly one session, not the others", () => {
  const { db, id } = withUser();
  const a = createSession(db, id, T0);
  const b = createSession(db, id, T0);
  destroySession(db, a);
  assert.equal(lookupSession(db, a, T0), null);
  assert.ok(lookupSession(db, b, T0), "signing out of one device must not sign out the rest");
});

test("sign-out-everywhere drops every session for the user", () => {
  const { db, id } = withUser();
  const a = createSession(db, id, T0);
  const b = createSession(db, id, T0);
  destroyUserSessions(db, id);
  assert.equal(lookupSession(db, a, T0), null);
  assert.equal(lookupSession(db, b, T0), null);
});

test("changing the password invalidates cookies issued under the old one", () => {
  const { db, id } = withUser();
  const token = createSession(db, id, T0);
  changePassword(db, id, "brand-new-pw-7");
  assert.equal(
    lookupSession(db, token, T0),
    null,
    "an old cookie outliving its password defeats the point of changing it"
  );
  assert.equal(authenticate(db, "pranav", "brand-new-pw-7", T0).ok, true);
  assert.equal(authenticate(db, "pranav", PW, T0).ok, false);
});

test("changing the password also clears a lockout", () => {
  const { db, id } = withUser();
  for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) {
    authenticate(db, "pranav", "wrong-12345", T0);
  }
  changePassword(db, id, "brand-new-pw-7");
  assert.equal(authenticate(db, "pranav", "brand-new-pw-7", T0).ok, true);
});

test("purge removes expired sessions and spares live ones", () => {
  const { db, id } = withUser();
  const old = createSession(db, id, T0);
  const fresh = createSession(db, id, at(SESSION_TTL_MS));
  const removed = purgeExpiredSessions(db, at(SESSION_TTL_MS + 1));
  assert.equal(removed, 1);
  assert.equal(lookupSession(db, old, at(SESSION_TTL_MS + 1)), null);
  assert.ok(lookupSession(db, fresh, at(SESSION_TTL_MS + 1)));
});

test("usernames are unique", () => {
  const { db } = withUser();
  assert.throws(() => createUser(db, "pranav", PW, T0));
  assert.throws(() => createUser(db, "PRANAV", PW, T0), /UNIQUE|constraint/i);
});
