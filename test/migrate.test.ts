import { strict as assert } from "node:assert";
import { test } from "node:test";
import Database from "better-sqlite3";
import { initSchema, seedCoreData } from "../src/lib/db";
import {
  appliedMigrations,
  assertBooksIntact,
  assertWellFormed,
  currentVersion,
  migrate,
  type Migration,
} from "../src/lib/migrate";

/**
 * Migration engine tests — RVOS-004 P1.
 *
 * This engine will be run ONCE against a real accounting firm's books, by
 * someone who cannot undo it. So the tests are mostly about what happens when
 * things go WRONG: a failing step, a failing backup, a migration that breaks
 * the books. Those are the paths that matter and the ones nobody exercises by
 * hand.
 */

const NOW = "2026-07-22T09:00:00.000Z";

function bookDb(): Database.Database {
  const db = new Database(":memory:");
  initSchema(db);
  seedCoreData(db);
  const acc = (code: string) =>
    (db.prepare("SELECT id FROM accounts WHERE code = ?").get(code) as { id: number }).id;
  db.prepare(
    `INSERT INTO journals (entry_date, entry_type, memo, ref_no, created_at)
     VALUES ('2026-07-20','journal','fixture','M-1','2026-07-20T00:00:00.000Z')`
  ).run();
  const jid = (db.prepare("SELECT MAX(id) AS id FROM journals").get() as { id: number }).id;
  const line = db.prepare(
    `INSERT INTO journal_lines (journal_id, line_no, account_id, debit_paise, credit_paise)
     VALUES (@j,@n,@a,@d,@c)`
  );
  line.run({ j: jid, n: 1, a: acc("1000"), d: 500000, c: 0 });
  line.run({ j: jid, n: 2, a: acc("1100"), d: 0, c: 500000 });
  return db;
}

const addTable = (version: number, name: string): Migration => ({
  version,
  name,
  up: (db) => db.exec(`CREATE TABLE IF NOT EXISTS t_${version} (id INTEGER PRIMARY KEY)`),
});

// ── versioning ───────────────────────────────────────────────────────────

test("a fresh database is at version 0 and migrates forward", () => {
  const db = bookDb();
  assert.equal(currentVersion(db), 0);
  const r = migrate(db, [addTable(1, "one"), addTable(2, "two")], { now: NOW });
  assert.deepEqual(r.applied.map((a) => a.version), [1, 2]);
  assert.equal(r.nowAtVersion, 2);
  assert.equal(appliedMigrations(db).length, 2);
  assert.equal(appliedMigrations(db)[0].applied_at, NOW, "clock is injected, not read");
});

test("re-running is a no-op — and does not even take a backup", () => {
  const db = bookDb();
  const ms = [addTable(1, "one")];
  migrate(db, ms, { now: NOW });

  let backups = 0;
  const r = migrate(db, ms, { now: NOW, backup: () => { backups++; return { path: "/x" }; } });
  assert.deepEqual(r.applied, []);
  assert.equal(r.nowAtVersion, 1);
  assert.equal(backups, 0, "a no-op start-up must not accumulate snapshots");
});

test("only pending migrations run when new ones are appended", () => {
  const db = bookDb();
  migrate(db, [addTable(1, "one")], { now: NOW });
  const r = migrate(db, [addTable(1, "one"), addTable(2, "two")], { now: NOW });
  assert.deepEqual(r.applied.map((a) => a.name), ["two"]);
  assert.equal(r.alreadyAtVersion, 1);
});

test("versions must be contiguous from 1 — a gap is refused", () => {
  assert.throws(() => assertWellFormed([addTable(1, "a"), addTable(3, "c")]), /contiguous/);
  assert.throws(() => assertWellFormed([addTable(2, "b")]), /contiguous/);
  assert.throws(
    () => assertWellFormed([{ version: 1, name: "  ", up: () => {} }]),
    /no name/
  );
  assert.doesNotThrow(() => assertWellFormed([addTable(2, "b"), addTable(1, "a")]));
});

// ── failure paths — the reason this file exists ──────────────────────────

test("a failing migration rolls back COMPLETELY and is not recorded", () => {
  const db = bookDb();
  const bad: Migration = {
    version: 1,
    name: "creates a table then explodes",
    up: (d) => {
      d.exec("CREATE TABLE half_done (id INTEGER PRIMARY KEY)");
      throw new Error("boom");
    },
  };
  assert.throws(() => migrate(db, [bad], { now: NOW }), /failed and was rolled back/);
  assert.equal(currentVersion(db), 0, "a failed migration must not be recorded");
  const leftover = db
    .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'half_done'")
    .get() as { n: number };
  assert.equal(leftover.n, 0, "its partial DDL must be gone too");
});

test("a later migration failing leaves the earlier ones applied, and says which broke", () => {
  const db = bookDb();
  const boom: Migration = { version: 2, name: "bad", up: () => { throw new Error("nope"); } };
  assert.throws(
    () => migrate(db, [addTable(1, "good"), boom], { now: NOW }),
    /Migration 2 \("bad"\)/
  );
  assert.equal(currentVersion(db), 1, "the good one stands");
});

test("NO schema change happens if the backup fails", () => {
  const db = bookDb();
  assert.throws(
    () =>
      migrate(db, [addTable(1, "one")], {
        now: NOW,
        backup: () => {
          throw new Error("destination unwritable");
        },
      }),
    /Refusing to migrate/
  );
  assert.equal(currentVersion(db), 0);
  const t = db
    .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 't_1'")
    .get() as { n: number };
  assert.equal(t.n, 0, "not one statement should have run");
});

test("the backup path is carried into the failure message", () => {
  const db = bookDb();
  const boom: Migration = { version: 1, name: "bad", up: () => { throw new Error("nope"); } };
  try {
    migrate(db, [boom], { now: NOW, backup: () => ({ path: "/snapshots/pre-migration" }) });
    assert.fail("should have thrown");
  } catch (err) {
    // Someone reading this message is mid-incident. Give them the path.
    assert.match(String(err), /\/snapshots\/pre-migration/);
  }
});

// ── the books must survive ───────────────────────────────────────────────

test("a migration that unbalances the books is rolled back", () => {
  const db = bookDb();
  const destructive: Migration = {
    version: 1,
    name: "drops half a journal",
    // The realistic catastrophe: a table rebuild that loses rows. The schema
    // change succeeds, the database opens fine, and the books are wrong.
    up: (d) => d.exec("DELETE FROM journal_lines WHERE line_no = 2"),
  };
  assert.throws(() => migrate(db, [destructive], { now: NOW }), /unbalanced/);
  assert.equal(currentVersion(db), 0);
  const n = (db.prepare("SELECT COUNT(*) AS n FROM journal_lines").get() as { n: number }).n;
  assert.equal(n, 2, "the deleted line must be back");
});

test("assertBooksIntact tolerates a database with no journals yet", () => {
  const empty = new Database(":memory:");
  assert.doesNotThrow(() => assertBooksIntact(empty));
  empty.close();
});

test("a custom verify can enforce anything, and rolls back on failure", () => {
  const db = bookDb();
  const m = addTable(1, "one");
  assert.throws(
    () =>
      migrate(db, [m], {
        now: NOW,
        verify: () => {
          throw new Error("my own invariant");
        },
      }),
    /my own invariant/
  );
  assert.equal(currentVersion(db), 0);
});

test("a real table rebuild preserves the books and records the version", () => {
  // The shape RVOS-004 P1 actually needs: rebuild a populated table to change
  // its constraints, inside one transaction, with the books re-proven after.
  const db = bookDb();
  const rebuild: Migration = {
    version: 1,
    name: "rebuild accounts with a scoped unique",
    up: (d) => {
      d.exec(`
        CREATE TABLE accounts_new (
          id         INTEGER PRIMARY KEY,
          company_id INTEGER NOT NULL DEFAULT 1,
          code       TEXT NOT NULL,
          name       TEXT NOT NULL,
          type       TEXT NOT NULL,
          group_code TEXT,
          UNIQUE (company_id, code)
        );
        INSERT INTO accounts_new (id, code, name, type, group_code)
          SELECT id, code, name, type, group_code FROM accounts;
      `);
      const before = (d.prepare("SELECT COUNT(*) AS n FROM accounts").get() as { n: number }).n;
      const after = (d.prepare("SELECT COUNT(*) AS n FROM accounts_new").get() as { n: number }).n;
      if (before !== after) throw new Error(`row count changed: ${before} -> ${after}`);
      d.exec("DROP TABLE accounts; ALTER TABLE accounts_new RENAME TO accounts;");
    },
  };
  const r = migrate(db, [rebuild], { now: NOW });
  assert.equal(r.nowAtVersion, 1);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM accounts").get() as { n: number }).n, 23);
  assert.doesNotThrow(() => assertBooksIntact(db));
  // The new constraint is real: same code, different company, is allowed.
  db.prepare(
    "INSERT INTO accounts (company_id, code, name, type) VALUES (2,'1000','Cash','asset')"
  ).run();
  assert.throws(
    () =>
      db
        .prepare("INSERT INTO accounts (company_id, code, name, type) VALUES (2,'1000','Dup','asset')")
        .run(),
    /UNIQUE/
  );
});

test("orphaned references are caught even though enforcement was off", () => {
  // The engine turns foreign_keys OFF so a table can be rebuilt at all. That
  // is a licence to leave orphans behind, so foreign_key_check runs INSIDE the
  // transaction to take the licence back. Without it, this migration would
  // commit and the books would reference accounts that no longer exist.
  const db = bookDb();
  const orphaner: Migration = {
    version: 1,
    name: "deletes an account the journals still point at",
    up: (d) => d.exec("DELETE FROM accounts WHERE code = '1000'"),
  };
  assert.throws(() => migrate(db, [orphaner], { now: NOW }), /orphaned foreign-key/);
  assert.equal(currentVersion(db), 0);
  const n = (db.prepare("SELECT COUNT(*) AS n FROM accounts WHERE code='1000'").get() as {
    n: number;
  }).n;
  assert.equal(n, 1, "the account must be back");
});

test("foreign-key enforcement is restored, on success AND on failure", () => {
  // Leaving it off would silently disarm every write the app makes afterwards
  // — a far worse outcome than the failed migration itself.
  const ok = bookDb();
  ok.pragma("foreign_keys = ON");
  migrate(ok, [addTable(1, "one")], { now: NOW });
  assert.equal(ok.pragma("foreign_keys", { simple: true }), 1, "restored after success");

  const bad = bookDb();
  bad.pragma("foreign_keys = ON");
  const boom: Migration = { version: 1, name: "bad", up: () => { throw new Error("nope"); } };
  assert.throws(() => migrate(bad, [boom], { now: NOW }));
  assert.equal(bad.pragma("foreign_keys", { simple: true }), 1, "restored after failure too");
});

