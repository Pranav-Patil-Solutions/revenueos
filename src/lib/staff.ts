import type Database from "better-sqlite3";
import { createUser } from "./auth";
import { ROLES } from "./roles";
import type { Role } from "./types";

/**
 * Staff administration — RVOS-006 P0b.
 *
 * GLOBAL, not per-company: a person works for the firm, not for one client's
 * book (see `GLOBAL_TABLES` in book.ts — `auth_users` is deliberately
 * unscoped). So these take a raw `Database`, not a `Book`, and the caller is
 * responsible for having checked `users.manage` first — `dal.ts` is the
 * authorization boundary, this module is the mechanism.
 *
 * ── The lockout invariant ──
 * `users.manage` is the only capability that can remove itself. An owner who
 * demotes the last owner leaves an installation where NOBODY can add a user,
 * restore anyone's access, or change a client's tax identity again — and there
 * is no password-reset email and no support channel, because this machine holds
 * the books and nothing else does. That is unrecoverable without hand-editing
 * SQLite, so it is refused here rather than warned about in the UI.
 */

export interface StaffMember {
  id: number;
  username: string;
  role: Role;
  created_at: string;
  last_login_at: string | null;
  locked_until: string | null;
}

export function listStaff(db: Database.Database): StaffMember[] {
  return db
    .prepare(
      `SELECT id, username, role, created_at, last_login_at, locked_until
       FROM auth_users ORDER BY username COLLATE NOCASE`
    )
    .all() as StaffMember[];
}

function assertRole(role: string): asserts role is Role {
  if (!ROLES.includes(role as Role)) {
    throw new Error(`"${role}" is not a role. Pick one of: ${ROLES.join(", ")}.`);
  }
}

/** How many owners can still sign in. Used by the lockout guard. */
export function ownerCount(db: Database.Database): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM auth_users WHERE role = 'owner'")
    .get() as { n: number };
  return row.n;
}

export function createStaff(
  db: Database.Database,
  input: { username: string; password: string; role: string },
  now: string
): number {
  assertRole(input.role);
  const id = createUser(db, input.username, input.password, now);
  // createUser predates roles and defaults to 'owner' (migration 005's chosen
  // direction for EXISTING rows). A deliberately-created user must get the role
  // that was actually asked for, so set it explicitly rather than relying on
  // that default.
  db.prepare("UPDATE auth_users SET role = @role WHERE id = @id").run({
    id,
    role: input.role,
  });
  return id;
}

/**
 * Change a role. Refuses to remove the last owner — see this module's docstring
 * on why that is unrecoverable rather than merely inconvenient.
 */
export function setStaffRole(
  db: Database.Database,
  userId: number,
  role: string
): void {
  assertRole(role);
  const current = db
    .prepare("SELECT id, username, role FROM auth_users WHERE id = @id")
    .get({ id: userId }) as { id: number; username: string; role: Role } | undefined;
  if (!current) throw new Error("No such user.");
  if (current.role === role) return; // idempotent

  if (current.role === "owner" && role !== "owner" && ownerCount(db) <= 1) {
    throw new Error(
      `"${current.username}" is the only owner. Promote someone else to owner ` +
        `first — an installation with no owner can never add a user or change a ` +
        `client's tax identity again, and there is no password-reset email here.`
    );
  }
  db.prepare("UPDATE auth_users SET role = @role WHERE id = @id").run({
    id: userId,
    role,
  });
}
