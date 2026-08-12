import { strict as assert } from "node:assert";
import { test } from "node:test";
import Database from "better-sqlite3";
import { book } from "../src/lib/book";
import { recentAudit, writeAudit } from "../src/lib/audit";
import { can, capabilitiesOf, refusalMessage, ROLES } from "../src/lib/roles";
import { postManualVoucher } from "../src/lib/vouchers";
import { postDocument } from "../src/lib/posting";
import type { Capability, Role } from "../src/lib/types";
import { createStaff, listStaff, ownerCount, setStaffRole } from "../src/lib/staff";
import { draftRows, settleId, stagedDb } from "./helpers";

/**
 * Attribution, roles and the audit trail — RVOS-006 P0b.
 *
 * The property under test throughout: the books can always say WHO, and where
 * they cannot they say "unknown" rather than guessing a name.
 */

const NOW = "2026-08-12T09:00:00.000Z";

function userId(db: Database.Database, username: string, role: Role): number {
  return Number(
    db
      .prepare(
        `INSERT INTO auth_users (username, password_hash, password_salt, created_at, role)
         VALUES (?, 'x', 'y', ?, ?)`
      )
      .run(username, NOW, role).lastInsertRowid
  );
}

// ---------------------------------------------------------------------------
// The capability matrix
// ---------------------------------------------------------------------------

test("posting is a strictly higher trust than staging — a clerk may stage, never post", () => {
  assert.equal(can("clerk", "entry.stage"), true);
  assert.equal(can("clerk", "entry.post"), false);
  // This is the line the whole role model exists to draw: staging is
  // reversible, posting writes immutable journals and there is no void yet.
  assert.equal(can("accountant", "entry.post"), true);
});

test("a viewer can do nothing but read", () => {
  assert.deepEqual(capabilitiesOf("viewer"), ["book.read"]);
});

test("only the owner may change a client's tax identity or add staff", () => {
  for (const role of ["accountant", "clerk", "viewer"] as Role[]) {
    assert.equal(can(role, "company.manage"), false, role);
    assert.equal(can(role, "users.manage"), false, role);
  }
  assert.equal(can("owner", "company.manage"), true);
  assert.equal(can("owner", "users.manage"), true);
});

test("every role can read, and every capability is held by the owner", () => {
  const all: Capability[] = [
    "book.read",
    "entry.stage",
    "entry.post",
    "books.lock",
    "accounts.manage",
    "company.manage",
    "users.manage",
  ];
  for (const role of ROLES) assert.equal(can(role, "book.read"), true, role);
  // No capability may be unreachable — one that no role holds is dead code
  // pretending to be a permission.
  for (const cap of all) {
    assert.equal(can("owner", cap), true, cap);
  }
});

test("a refusal names the role that was refused and what would be needed", () => {
  const msg = refusalMessage("clerk", "entry.post");
  assert.match(msg, /Clerk/);
  assert.match(msg, /Owner or Accountant/);
});

// ---------------------------------------------------------------------------
// Attribution on the books
// ---------------------------------------------------------------------------

test("a posted journal records WHO posted it", () => {
  const db = stagedDb();
  const uid = userId(db, "asha", "accountant");
  postDocument(book(db, 1, uid), 1, draftRows(db, [10]));
  const rows = db
    .prepare("SELECT DISTINCT created_by FROM journals WHERE company_id = 1")
    .all() as { created_by: number | null }[];
  assert.deepEqual(rows, [{ created_by: uid }]);
});

test("a manual voucher records its author too", () => {
  const db = stagedDb();
  const uid = userId(db, "asha", "accountant");
  const b = book(db, 1, uid);
  const { journalId } = postManualVoucher(b, {
    kind: "contra",
    entry_date: "2026-07-20",
    memo: "",
    ref_no: "",
    from_bank_account_id: settleId(db, 1, "cash"),
    to_bank_account_id: settleId(db, 1, "bank"),
    amount_paise: 1000,
  });
  const row = db
    .prepare("SELECT created_by FROM journals WHERE id = ?")
    .get(journalId) as { created_by: number | null };
  assert.equal(row.created_by, uid);
});

test("NULL author is preserved as unknown, never backfilled to a guess", () => {
  // A Book with no actor is what a migration, a CLI script or a test has.
  // Recording "unknown" is correct; inventing the only user's name would be
  // fabricating an audit trail.
  const db = stagedDb();
  postDocument(book(db, 1), 1, draftRows(db, [10]));
  const rows = db
    .prepare("SELECT DISTINCT created_by FROM journals WHERE company_id = 1")
    .all() as { created_by: number | null }[];
  assert.deepEqual(rows, [{ created_by: null }]);

  // And the log renders it as an absent username rather than a name.
  const entries = recentAudit(book(db, 1));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].actor_user_id, null);
  assert.equal(entries[0].actor_username, null);
});

// ---------------------------------------------------------------------------
// The audit trail
// ---------------------------------------------------------------------------

test("posting a document writes exactly one audit row naming the actor", () => {
  const db = stagedDb();
  const uid = userId(db, "asha", "accountant");
  const b = book(db, 1, uid);
  postDocument(b, 1, draftRows(db, [10]));

  const entries = recentAudit(b);
  assert.equal(entries.length, 1, "one row for the document, not one per journal");
  assert.equal(entries[0].action, "document.post");
  assert.equal(entries[0].entity, "document");
  assert.equal(entries[0].entity_id, 1);
  assert.equal(entries[0].actor_user_id, uid);
  assert.equal(entries[0].actor_username, "asha");
  assert.match(entries[0].summary, /Posted document #1 — 9 journals/);
});

test("a rolled-back post leaves NO audit row — the log cannot claim a change that did not happen", () => {
  const db = stagedDb();
  const b = book(db, 1, userId(db, "asha", "accountant"));
  // An included row with no date makes postDocument throw mid-transaction.
  db.prepare("UPDATE staged_rows SET entry_date = NULL WHERE row_no = 2").run();
  assert.throws(() => postDocument(b, 1, draftRows(db, [10])), /needs a date/);
  assert.equal(recentAudit(b).length, 0);
  assert.equal(
    (db.prepare("SELECT COUNT(*) n FROM journals").get() as { n: number }).n,
    0
  );
});

test("audit_log is append-only at the SQL level — UPDATE and DELETE both abort", () => {
  const db = stagedDb();
  const b = book(db, 1, userId(db, "asha", "owner"));
  writeAudit(b, { action: "test.act", entity: "thing", summary: "did a thing" }, NOW);
  const id = (db.prepare("SELECT id FROM audit_log LIMIT 1").get() as { id: number }).id;

  // A trail the application can rewrite is not evidence of anything, so this
  // is enforced by triggers rather than by everyone remembering not to.
  assert.throws(
    () => db.prepare("UPDATE audit_log SET summary = 'tampered' WHERE id = ?").run(id),
    /append-only/
  );
  assert.throws(
    () => db.prepare("DELETE FROM audit_log WHERE id = ?").run(id),
    /append-only/
  );
  const row = db.prepare("SELECT summary FROM audit_log WHERE id = ?").get(id) as {
    summary: string;
  };
  assert.equal(row.summary, "did a thing");
});

test("audit rows never cross companies", () => {
  const db = stagedDb();
  const b = book(db, 1, userId(db, "asha", "owner"));
  writeAudit(b, { action: "a.b", entity: "x", summary: "company 1 only" }, NOW);
  // Company 2 does not exist in this fixture, so read through a Book for it and
  // confirm the scoping filter — not the row count — is what hides the row.
  const other = book(db, 2);
  assert.equal(recentAudit(other).length, 0);
  assert.equal(recentAudit(b).length, 1);
});

test("existing users default to owner, because nothing restricted them before", () => {
  // Migration 005's chosen direction: demoting the office's existing logins
  // would silently remove access they already rely on, and on a single-user
  // install would lock them out of their own books.
  const db = stagedDb();
  const id = Number(
    db
      .prepare(
        `INSERT INTO auth_users (username, password_hash, password_salt, created_at)
         VALUES ('legacy', 'x', 'y', ?)`
      )
      .run(NOW).lastInsertRowid
  );
  const row = db.prepare("SELECT role FROM auth_users WHERE id = ?").get(id) as {
    role: string;
  };
  assert.equal(row.role, "owner");
});

test("an unknown role is refused by the schema, not silently accepted", () => {
  const db = stagedDb();
  assert.throws(
    () =>
      db
        .prepare(
          `INSERT INTO auth_users (username, password_hash, password_salt, created_at, role)
           VALUES ('bad', 'x', 'y', ?, 'superuser')`
        )
        .run(NOW),
    /CHECK constraint failed/
  );
});

// ---------------------------------------------------------------------------
// Staff administration and the lockout invariant
// ---------------------------------------------------------------------------

test("a deliberately-created staff member gets the role asked for, not the legacy default", () => {
  const db = stagedDb();
  const id = createStaff(
    db,
    { username: "clerk1", password: "aValidPass1", role: "clerk" },
    NOW
  );
  assert.equal(listStaff(db).find((s) => s.id === id)!.role, "clerk");
});

test("demoting the LAST owner is refused — it is an unrecoverable lockout", () => {
  const db = stagedDb();
  const owner = createStaff(
    db,
    { username: "owner1", password: "aValidPass1", role: "owner" },
    NOW
  );
  assert.equal(ownerCount(db), 1);
  assert.throws(() => setStaffRole(db, owner, "viewer"), /only owner/);
  assert.equal(listStaff(db).find((s) => s.id === owner)!.role, "owner");
});

test("demoting an owner is allowed once another owner exists", () => {
  const db = stagedDb();
  const first = createStaff(
    db,
    { username: "owner1", password: "aValidPass1", role: "owner" },
    NOW
  );
  createStaff(db, { username: "owner2", password: "aValidPass1", role: "owner" }, NOW);
  setStaffRole(db, first, "accountant");
  assert.equal(listStaff(db).find((s) => s.id === first)!.role, "accountant");
  assert.equal(ownerCount(db), 1);
});

test("an unknown role is refused before it reaches the database", () => {
  const db = stagedDb();
  assert.throws(
    () => createStaff(db, { username: "x", password: "aValidPass1", role: "admin" }, NOW),
    /is not a role/
  );
});
