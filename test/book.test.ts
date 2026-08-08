import { strict as assert } from "node:assert";
import { test } from "node:test";
import Database from "better-sqlite3";
import { initSchema, seedCoreData } from "../src/lib/db";
import { migrate } from "../src/lib/migrate";
import { MIGRATIONS } from "../src/lib/migrations";
import {
  assertUsableCompany,
  book,
  scopedTablesIn,
  scopingProblem,
  SCOPED_TABLES,
} from "../src/lib/book";

/**
 * Book handle — RVOS-004 P2.
 *
 * The tests that matter here are the REFUSALS. A handle that merely binds
 * company_id would still let someone forget a WHERE clause and silently read
 * every client's books; this one has to make that impossible.
 */

const NOW = "2026-07-22T09:00:00.000Z";

function twoCompanyDb(): Database.Database {
  const db = new Database(":memory:");
  initSchema(db);
  seedCoreData(db);
  migrate(db, MIGRATIONS, { now: NOW });
  db.prepare("INSERT INTO companies (id, name) VALUES (2, 'Second Client')").run();

  // A party and a journal in each company, with distinguishable amounts.
  for (const [companyId, party, amount] of [
    [1, "Acme (company 1)", 100000],
    [2, "Beta (company 2)", 900000],
  ] as const) {
    db.prepare(
      `INSERT INTO parties (company_id, name, kind, gstin, state_code, phone, created_at)
       VALUES (@c,@n,'customer','','27','','2026-04-01T00:00:00.000Z')`
    ).run({ c: companyId, n: party });
    db.prepare(
      `INSERT INTO journals (company_id, entry_date, entry_type, memo, ref_no, created_at)
       VALUES (@c,'2026-05-01','journal',@m,'R-1','2026-05-01T00:00:00.000Z')`
    ).run({ c: companyId, m: `book of ${companyId}` });
    const jid = (db.prepare("SELECT MAX(id) AS id FROM journals").get() as { id: number }).id;
    const accId = (
      db.prepare("SELECT id FROM accounts WHERE company_id = 1 AND code = '1000'").get() as {
        id: number;
      }
    ).id;
    const line = db.prepare(
      `INSERT INTO journal_lines (company_id, journal_id, line_no, account_id, debit_paise, credit_paise)
       VALUES (@c,@j,@n,@a,@d,@cr)`
    );
    line.run({ c: companyId, j: jid, n: 1, a: accId, d: amount, cr: 0 });
    line.run({ c: companyId, j: jid, n: 2, a: accId, d: 0, cr: amount });
  }
  return db;
}

// ── the refusal, which is the whole point ────────────────────────────────

test("a query touching a scoped table without company_id is REFUSED", () => {
  const db = twoCompanyDb();
  const b = book(db, 1);
  assert.throws(
    () => b.all("SELECT * FROM journals"),
    /without mentioning company_id/,
    "the silent cross-client read must be impossible, not merely discouraged"
  );
  assert.throws(() => b.get("SELECT COUNT(*) AS n FROM journal_lines"), /company_id/);
  assert.throws(() => b.run("DELETE FROM parties"), /company_id/);
});

test("the refusal names the tables it caught, so the fix is obvious", () => {
  const problem = scopingProblem("SELECT * FROM journals j JOIN parties p ON p.id = j.id");
  assert.ok(problem);
  assert.match(problem!, /journals/);
  assert.match(problem!, /parties/);
  assert.match(problem!, /@company_id/);
});

test("global tables pass through untouched", () => {
  const db = twoCompanyDb();
  const b = book(db, 1);
  // Firm staff and the migration ledger belong to the installation, not a
  // client — requiring company_id on them would be wrong.
  assert.doesNotThrow(() => b.all("SELECT * FROM auth_users"));
  assert.doesNotThrow(() => b.all("SELECT * FROM schema_version"));
  assert.doesNotThrow(() => b.all("SELECT * FROM companies"));
});

test("a table name inside a string or comment does not trip the check", () => {
  // Otherwise the guard becomes something people work around rather than with.
  assert.equal(scopingProblem("SELECT 'journals are fun' AS note"), null);
  assert.equal(scopingProblem("-- journals\nSELECT 1"), null);
  assert.equal(scopingProblem("/* parties */ SELECT 1"), null);
  assert.equal(scopingProblem("SELECT * FROM journals WHERE company_id = @company_id"), null);
});

test("scopedTablesIn matches whole words only", () => {
  assert.deepEqual(scopedTablesIn("SELECT * FROM journals_archive"), []);
  assert.deepEqual(scopedTablesIn("SELECT * FROM my_parties"), []);
  assert.deepEqual(scopedTablesIn("SELECT * FROM parties"), ["parties"]);
});

// ── isolation ────────────────────────────────────────────────────────────

test("a book sees ONLY its own company's rows", () => {
  const db = twoCompanyDb();
  const one = book(db, 1);
  const two = book(db, 2);

  const names1 = one
    .all<{ name: string }>("SELECT name FROM parties WHERE company_id = @company_id")
    .map((r) => r.name);
  const names2 = two
    .all<{ name: string }>("SELECT name FROM parties WHERE company_id = @company_id")
    .map((r) => r.name);

  assert.deepEqual(names1, ["Acme (company 1)"]);
  assert.deepEqual(names2, ["Beta (company 2)"]);
});

test("company_id cannot be overridden by a caller's params", () => {
  // A params object carrying company_id must not be able to widen or redirect
  // the scope — the handle binds last and wins.
  const db = twoCompanyDb();
  const one = book(db, 1);
  const rows = one.all<{ name: string }>(
    "SELECT name FROM parties WHERE company_id = @company_id",
    { company_id: 2 } as Record<string, unknown>
  );
  assert.deepEqual(rows.map((r) => r.name), ["Acme (company 1)"], "the handle's id must win");
});

test("totals differ per book — a leak would show up as the wrong number", () => {
  const db = twoCompanyDb();
  const total = (id: number) =>
    book(db, id).get<{ d: number }>(
      "SELECT COALESCE(SUM(debit_paise),0) AS d FROM journal_lines WHERE company_id = @company_id"
    )!.d;
  assert.equal(total(1), 100000);
  assert.equal(total(2), 900000);
  // The unscoped total is what a missing WHERE clause would have produced.
  const both = (db.prepare("SELECT COALESCE(SUM(debit_paise),0) AS d FROM journal_lines").get() as {
    d: number;
  }).d;
  assert.equal(both, 1000000);
  assert.notEqual(total(1), both, "company 1 must not see the combined figure");
});

test("writes land on the handle's company, not the caller's claim", () => {
  const db = twoCompanyDb();
  book(db, 2).run(
    `INSERT INTO parties (company_id, name, kind, gstin, state_code, phone, created_at)
     VALUES (@company_id, 'Written by book 2', 'customer', '', '27', '', '2026-05-01')`
  );
  const owner = db
    .prepare("SELECT company_id FROM parties WHERE name = 'Written by book 2'")
    .get() as { company_id: number };
  assert.equal(owner.company_id, 2);
});

test("a transaction stays scoped and rolls back as one", () => {
  const db = twoCompanyDb();
  const b = book(db, 1);
  const before = b.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM parties WHERE company_id = @company_id"
  )!.n;
  assert.throws(() =>
    b.tx((inner) => {
      inner.run(
        `INSERT INTO parties (company_id, name, kind, gstin, state_code, phone, created_at)
         VALUES (@company_id,'doomed','customer','','27','','2026-05-01')`
      );
      throw new Error("abort");
    })
  );
  const after = b.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM parties WHERE company_id = @company_id"
  )!.n;
  assert.equal(after, before);
});

// ── company resolution ───────────────────────────────────────────────────

test("an invalid company id is refused at construction", () => {
  const db = twoCompanyDb();
  for (const bad of [0, -1, 1.5, NaN]) {
    assert.throws(() => book(db, bad as number), /Invalid company id/);
  }
});

test("a missing or archived company cannot be opened", () => {
  const db = twoCompanyDb();
  assert.doesNotThrow(() => assertUsableCompany(db, 1));
  assert.throws(() => assertUsableCompany(db, 99), /No such company/);
  db.prepare("UPDATE companies SET archived_at = '2026-07-01' WHERE id = 2").run();
  assert.throws(() => assertUsableCompany(db, 2), /archived/);
});

test("every scoped table really has a company_id column after migration", () => {
  // Keeps SCOPED_TABLES honest against the schema rather than against memory.
  const db = twoCompanyDb();
  for (const t of SCOPED_TABLES) {
    const cols = (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map(
      (c) => c.name
    );
    assert.ok(cols.includes("company_id"), `${t} is listed as scoped but has no company_id`);
  }
});
