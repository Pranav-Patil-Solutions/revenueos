import { strict as assert } from "node:assert";
import { test } from "node:test";
import Database from "better-sqlite3";
import { initSchema, seedCoreData } from "../src/lib/db";
import { migrate, currentVersion, assertBooksIntact } from "../src/lib/migrate";
import { MIGRATIONS } from "../src/lib/migrations";

/**
 * Migration 001 — RVOS-004 P1.
 *
 * This runs once against a real accounting firm's books. The tests build a
 * database that looks like theirs — accounts, parties, a posted journal,
 * compliance marks, a Tally mapping, an opening WDV — migrate it, and assert
 * that nothing moved except what was supposed to.
 */

const NOW = "2026-07-22T09:00:00.000Z";

/** A book with something in every table migration 001 touches. */
function officeDb(): Database.Database {
  const db = new Database(":memory:");
  initSchema(db);
  seedCoreData(db);
  const acc = (code: string) =>
    (db.prepare("SELECT id FROM accounts WHERE code = ?").get(code) as { id: number }).id;

  db.prepare(
    "UPDATE settings SET company_name = 'Sharma & Co', gstin = '27AAAPL1234C1ZV', pan = 'AAAPL1234C', entity_type = 'partnership' WHERE id = 1"
  ).run();

  db.prepare(
    `INSERT INTO parties (name, kind, gstin, state_code, phone, created_at)
     VALUES ('Acme Traders','customer','','27','','2026-04-01T00:00:00.000Z')`
  ).run();
  const partyId = (db.prepare("SELECT MAX(id) AS id FROM parties").get() as { id: number }).id;

  db.prepare(
    `INSERT INTO journals (entry_date, entry_type, memo, ref_no, created_at)
     VALUES ('2026-05-10','journal','opening','OP-1','2026-05-10T00:00:00.000Z')`
  ).run();
  const jid = (db.prepare("SELECT MAX(id) AS id FROM journals").get() as { id: number }).id;
  const line = db.prepare(
    `INSERT INTO journal_lines (journal_id, line_no, account_id, party_id, debit_paise, credit_paise)
     VALUES (@j,@n,@a,@p,@d,@c)`
  );
  line.run({ j: jid, n: 1, a: acc("1200"), p: partyId, d: 4500000, c: 0 });
  line.run({ j: jid, n: 2, a: acc("3000"), p: null, d: 0, c: 4500000 });

  db.prepare(
    `INSERT INTO compliance_marks (rule_code, period, status, marked_at, note)
     VALUES ('gstr1','2026-04','done','2026-05-11T00:00:00.000Z','filed')`
  ).run();
  db.prepare(
    `INSERT INTO ledger_mappings (ledger_name, target_kind, account_id, party_id, created_at)
     VALUES ('Sales A/c','account',@a,NULL,'2026-05-01T00:00:00.000Z')`
  ).run({ a: acc("4000") });
  db.prepare(
    `INSERT INTO wdv_openings (fy, block, opening_paise, created_at)
     VALUES ('2026-27','computers',10000000,'2026-04-01T00:00:00.000Z')`
  ).run();
  return db;
}

const count = (db: Database.Database, t: string) =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;

test("migration 001 moves the existing book to company 1, intact", () => {
  const db = officeDb();
  const before = {
    accounts: count(db, "accounts"),
    parties: count(db, "parties"),
    journals: count(db, "journals"),
    lines: count(db, "journal_lines"),
    marks: count(db, "compliance_marks"),
    mappings: count(db, "ledger_mappings"),
    wdv: count(db, "wdv_openings"),
  };

  const r = migrate(db, MIGRATIONS, { now: NOW });
  assert.equal(r.nowAtVersion, MIGRATIONS.length);

  // Nothing lost, nothing duplicated.
  assert.equal(count(db, "accounts"), before.accounts);
  assert.equal(count(db, "parties"), before.parties);
  assert.equal(count(db, "journals"), before.journals);
  assert.equal(count(db, "journal_lines"), before.lines);
  assert.equal(count(db, "compliance_marks"), before.marks);
  assert.equal(count(db, "ledger_mappings"), before.mappings);
  assert.equal(count(db, "wdv_openings"), before.wdv);
  assert.doesNotThrow(() => assertBooksIntact(db));
});

test("the settings singleton becomes company 1, keeping every field", () => {
  const db = officeDb();
  migrate(db, MIGRATIONS, { now: NOW });

  const c = db.prepare("SELECT * FROM companies WHERE id = 1").get() as Record<string, unknown>;
  assert.ok(c, "the existing book must survive as company 1");
  assert.equal(c.name, "Sharma & Co", "named from company_name so it is recognisable");
  assert.equal(c.company_name, "Sharma & Co");
  assert.equal(c.gstin, "27AAAPL1234C1ZV");
  assert.equal(c.pan, "AAAPL1234C");
  // The ensureColumn-added fields are the ones a hardcoded column list drops.
  assert.equal(c.entity_type, "partnership");
  assert.equal(c.archived_at, null);
});

test("every book-bearing row lands on company 1 — none left unassigned", () => {
  const db = officeDb();
  migrate(db, MIGRATIONS, { now: NOW });
  for (const t of [
    "accounts",
    "parties",
    "journals",
    "journal_lines",
    "compliance_marks",
    "ledger_mappings",
    "wdv_openings",
  ]) {
    const stray = (
      db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE company_id IS NOT 1`).get() as {
        n: number;
      }
    ).n;
    assert.equal(stray, 0, `${t} has rows not assigned to company 1`);
  }
});

test("UNIQUE constraints are now PER COMPANY — the whole point", () => {
  const db = officeDb();
  migrate(db, MIGRATIONS, { now: NOW });
  db.prepare("INSERT INTO companies (id, name) VALUES (2, 'Second Client')").run();

  // The same account code, mapping name, compliance period and WDV block must
  // all be usable again by a different client. Before this migration each of
  // these would have collided.
  assert.doesNotThrow(() =>
    db
      .prepare("INSERT INTO accounts (company_id, code, name, type) VALUES (2,'1000','Cash','asset')")
      .run()
  );
  assert.doesNotThrow(() =>
    db
      .prepare(
        `INSERT INTO ledger_mappings (company_id, ledger_name, target_kind, account_id, created_at)
         VALUES (2,'Sales A/c','account',(SELECT id FROM accounts WHERE company_id=2 AND code='1000'),'x')`
      )
      .run()
  );
  assert.doesNotThrow(() =>
    db
      .prepare(
        "INSERT INTO compliance_marks (company_id, rule_code, period, status, marked_at) VALUES (2,'gstr1','2026-04','done','x')"
      )
      .run()
  );
  assert.doesNotThrow(() =>
    db
      .prepare(
        "INSERT INTO wdv_openings (company_id, fy, block, opening_paise, created_at) VALUES (2,'2026-27','computers',1,'x')"
      )
      .run()
  );

  // ...and are still enforced WITHIN a company.
  assert.throws(
    () =>
      db
        .prepare("INSERT INTO accounts (company_id, code, name, type) VALUES (2,'1000','Dup','asset')")
        .run(),
    /UNIQUE/
  );
  assert.throws(
    () =>
      db
        .prepare(
          "INSERT INTO compliance_marks (company_id, rule_code, period, status, marked_at) VALUES (2,'gstr1','2026-04','na','x')"
        )
        .run(),
    /UNIQUE/
  );
});

test("the journal still points at the right account and party after the rebuild", () => {
  // accounts is dropped and recreated, so every reference through it is worth
  // re-proving rather than assuming SQLite did the right thing.
  const db = officeDb();
  migrate(db, MIGRATIONS, { now: NOW });
  const row = db
    .prepare(
      `SELECT a.code AS code, p.name AS party, l.debit_paise AS dr
         FROM journal_lines l
         JOIN accounts a ON a.id = l.account_id
         LEFT JOIN parties p ON p.id = l.party_id
        WHERE l.debit_paise > 0`
    )
    .get() as { code: string; party: string; dr: number };
  assert.equal(row.code, "1200");
  assert.equal(row.party, "Acme Traders");
  assert.equal(row.dr, 4500000);
});

test("migrating twice changes nothing", () => {
  const db = officeDb();
  migrate(db, MIGRATIONS, { now: NOW });
  const snapshot = {
    companies: count(db, "companies"),
    accounts: count(db, "accounts"),
    lines: count(db, "journal_lines"),
  };
  const again = migrate(db, MIGRATIONS, { now: NOW });
  assert.deepEqual(again.applied, []);
  assert.equal(currentVersion(db), MIGRATIONS.length);
  assert.equal(count(db, "companies"), snapshot.companies);
  assert.equal(count(db, "accounts"), snapshot.accounts);
  assert.equal(count(db, "journal_lines"), snapshot.lines);
});

test("an empty database migrates cleanly too", () => {
  // A brand-new install runs the same path; it must not depend on there being
  // a settings row to carry across.
  const db = new Database(":memory:");
  initSchema(db);
  db.prepare("DELETE FROM settings").run();
  assert.doesNotThrow(() => migrate(db, MIGRATIONS, { now: NOW }));
  assert.equal(count(db, "companies"), 0);
  assert.equal(currentVersion(db), MIGRATIONS.length);
});

test("foreign-key enforcement survives the migration", () => {
  const db = officeDb();
  db.pragma("foreign_keys = ON");
  migrate(db, MIGRATIONS, { now: NOW });
  assert.equal(db.pragma("foreign_keys", { simple: true }), 1);
  // And it actually bites afterwards.
  assert.throws(
    () =>
      db
        .prepare(
          "INSERT INTO journal_lines (journal_id, line_no, account_id, debit_paise, credit_paise) VALUES (99999,1,1,100,0)"
        )
        .run(),
    /FOREIGN KEY/
  );
});

test("migration 002 — a session's company starts NULL, and can be set to a real company", () => {
  const db = officeDb();
  db.prepare(
    `INSERT INTO auth_users (username, password_hash, password_salt, created_at)
     VALUES ('dad', 'h', 's', @now)`
  ).run({ now: NOW });
  db.prepare(
    `INSERT INTO auth_sessions (token_sha256, user_id, created_at, expires_at, last_seen_at)
     VALUES ('sha', 1, @now, @exp, @now)`
  ).run({ now: NOW, exp: "2026-07-23T09:00:00.000Z" });

  migrate(db, MIGRATIONS, { now: NOW });

  const before = db
    .prepare("SELECT company_id FROM auth_sessions WHERE token_sha256 = 'sha'")
    .get() as { company_id: number | null };
  assert.equal(before.company_id, null, "a session minted before this migration chose nothing");

  db.prepare("UPDATE auth_sessions SET company_id = 1 WHERE token_sha256 = 'sha'").run();
  const after = db
    .prepare("SELECT company_id FROM auth_sessions WHERE token_sha256 = 'sha'")
    .get() as { company_id: number | null };
  assert.equal(after.company_id, 1);

  // The REFERENCES clause is real, not decorative.
  db.pragma("foreign_keys = ON");
  assert.throws(
    () =>
      db
        .prepare("UPDATE auth_sessions SET company_id = 999 WHERE token_sha256 = 'sha'")
        .run(),
    /FOREIGN KEY/
  );
});
