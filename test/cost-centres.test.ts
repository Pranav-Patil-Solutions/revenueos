import { strict as assert } from "node:assert";
import { test } from "node:test";
import Database from "better-sqlite3";
import { book } from "../src/lib/book";
import { createCompany } from "../src/lib/companies";
import {
  archiveCostCentre,
  assertOwnedCostCentre,
  codeFromName,
  costCentreUsage,
  createCostCentre,
  getCostCentre,
  listCostCentres,
  renameCostCentre,
  resolveCostCentre,
} from "../src/lib/cost-centres";
import { initSchema, seedAccountsForCompany, seedCoreData } from "../src/lib/db";
import { migrate } from "../src/lib/migrate";
import { MIGRATIONS } from "../src/lib/migrations";
import { applyDraftRows, postDocument } from "../src/lib/posting";
import { trialBalance } from "../src/lib/reports";
import { postManualVoucher, postVoucherWithTds } from "../src/lib/vouchers";
import { draftRows, settleId, stagedDb } from "./helpers";

const NOW = "2026-08-13T09:00:00.000Z";

/**
 * Cost centres — RVOS-006 P0c.
 *
 * Three properties this dimension must hold, in order of what a failure would
 * cost the office:
 *
 *   1. It never crosses companies — the same worst failure class as every
 *      other scoped table (see import-isolation.test.ts).
 *   2. It reaches ONLY income and expense lines. Tagging a control, tax or
 *      settlement leg would make every future cost-centre report double-count
 *      the same rupee, and it would look plausible while doing it.
 *   3. It changes no number. A tag is a tag: the same journals, the same
 *      amounts, a trial balance still at zero.
 */

function twoCompanyDb(): { db: Database.Database; companyA: number; companyB: number } {
  const db = new Database(":memory:");
  initSchema(db);
  seedCoreData(db);
  migrate(db, MIGRATIONS, { now: NOW });
  const companyA = 1;
  const companyB = createCompany(db, { name: "Client B" }, NOW);
  seedAccountsForCompany(db, companyB);
  return { db, companyA, companyB };
}

function legsOf(db: Database.Database, journalId: number) {
  return db
    .prepare(
      `SELECT a.code, a.type, jl.cost_centre_id, jl.debit_paise, jl.credit_paise
       FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
       WHERE jl.journal_id = ? ORDER BY jl.line_no`
    )
    .all(journalId) as {
    code: string;
    type: string;
    cost_centre_id: number | null;
    debit_paise: number;
    credit_paise: number;
  }[];
}

// ---------------------------------------------------------------------------
// The register itself
// ---------------------------------------------------------------------------

test("a code is derived from the name when none is given", () => {
  assert.equal(codeFromName("Shop — Kothrud"), "SHOP-KOTHRUD");
  assert.equal(codeFromName("  site 2  "), "SITE-2");
  const { db, companyA } = twoCompanyDb();
  const id = createCostCentre(book(db, companyA), { name: "Service arm" });
  assert.equal(getCostCentre(book(db, companyA), id)!.code, "SERVICE-ARM");
});

test("a duplicate code is refused in a sentence, including against an archived one", () => {
  const { db, companyA } = twoCompanyDb();
  const b = book(db, companyA);
  const id = createCostCentre(b, { name: "Shop A" });
  assert.throws(() => createCostCentre(b, { name: "Shop A" }), /already used/);
  archiveCostCentre(b, id, NOW);
  // Still refused: the archived row still occupies the code, and reusing it
  // would make two different centres indistinguishable in old reports.
  assert.throws(() => createCostCentre(b, { name: "Shop A" }), /archived/);
});

test("archived centres leave the pickers but stay in the book", () => {
  const { db, companyA } = twoCompanyDb();
  const b = book(db, companyA);
  const id = createCostCentre(b, { name: "Shop A" });
  archiveCostCentre(b, id, NOW);
  assert.deepEqual(listCostCentres(b), []);
  assert.equal(listCostCentres(b, { includeArchived: true }).length, 1);
  assert.ok(getCostCentre(b, id));
  // Idempotent — a double-submitted archive is not an error.
  archiveCostCentre(b, id, NOW);
});

test("the LAST cost centre may be archived — unlike the last bank account", () => {
  // Deliberate difference: ingestion must resolve a settle hint to SOME bank
  // account, so archiving the last one strands every future import. Nothing
  // has to resolve to a cost centre — the column is nullable — so a book with
  // none is a book that stopped using the dimension, not a broken one.
  const { db, companyA } = twoCompanyDb();
  const b = book(db, companyA);
  const id = createCostCentre(b, { name: "Only one" });
  archiveCostCentre(b, id, NOW);
  assert.deepEqual(listCostCentres(b), []);
});

test("rename changes the name, never the code reports are keyed by", () => {
  const { db, companyA } = twoCompanyDb();
  const b = book(db, companyA);
  const id = createCostCentre(b, { name: "Shop A", code: "SHOP-A" });
  renameCostCentre(b, id, "Shop A — Kothrud");
  const row = getCostCentre(b, id)!;
  assert.equal(row.name, "Shop A — Kothrud");
  assert.equal(row.code, "SHOP-A");
});

test("every mutation writes an audit row", () => {
  const { db, companyA } = twoCompanyDb();
  const b = book(db, companyA);
  const id = createCostCentre(b, { name: "Shop A" });
  renameCostCentre(b, id, "Shop A (north)");
  archiveCostCentre(b, id, NOW);
  const actions = (
    b.all(
      `SELECT action FROM audit_log WHERE company_id = @company_id AND entity = 'cost_centre'
       ORDER BY id`
    ) as { action: string }[]
  ).map((r) => r.action);
  assert.deepEqual(actions, [
    "cost_centre.create",
    "cost_centre.rename",
    "cost_centre.archive",
  ]);
});

// ---------------------------------------------------------------------------
// Tenancy
// ---------------------------------------------------------------------------

test("company A cannot see, resolve or use company B's cost centre — even by its real id", () => {
  const { db, companyA, companyB } = twoCompanyDb();
  const a = book(db, companyA);
  const bb = book(db, companyB);
  const theirs = createCostCentre(bb, { name: "Their shop" });
  const mine = createCostCentre(a, { name: "My shop" });

  assert.deepEqual(
    listCostCentres(a).map((c) => c.id),
    [mine]
  );
  assert.equal(getCostCentre(a, theirs), undefined);
  assert.throws(() => resolveCostCentre(a, theirs), /does not exist in this book/);
  assert.throws(() => assertOwnedCostCentre(a, theirs), /not in this book/);
  // And the reverse direction, so this isn't passing by id ordering.
  assert.equal(getCostCentre(bb, mine), undefined);
});

test("a voucher cannot post through another company's cost centre", () => {
  const db = stagedDb();
  const companyB = createCompany(db, { name: "Client B" }, NOW);
  seedAccountsForCompany(db, companyB);
  const theirs = createCostCentre(book(db, companyB), { name: "Their shop" });
  assert.throws(
    () =>
      postManualVoucher(book(db, 1), {
        kind: "sale",
        entry_date: "2026-07-20",
        memo: "Leak attempt",
        ref_no: "X-1",
        party_id: 1,
        amount_paise: 118_000,
        gst_rate: 18,
        bank_account_id: settleId(db, 1, "cash"),
        cost_centre_id: theirs,
      }),
    /does not exist in this book/
  );
  const journals = db
    .prepare("SELECT COUNT(*) AS n FROM journals WHERE company_id = 1")
    .get() as { n: number };
  assert.equal(journals.n, 0, "the refusal left no half-written journal");
});

test("a draft row cannot be SAVED with another company's cost centre either", () => {
  // saveDraft never reaches postDocument's checks, so a cross-company id would
  // otherwise sit persisted on a staged row until someone posted it.
  const db = stagedDb();
  const companyB = createCompany(db, { name: "Client B" }, NOW);
  seedAccountsForCompany(db, companyB);
  const theirs = createCostCentre(book(db, companyB), { name: "Their shop" });
  const rows = draftRows(db);
  rows[0] = { ...rows[0], cost_centre_id: theirs };
  assert.throws(
    () => book(db, 1).tx((b) => applyDraftRows(b, 1, rows)),
    /not in this book/
  );
});

// ---------------------------------------------------------------------------
// Where the tag lands
// ---------------------------------------------------------------------------

test("a purchase voucher tags ONLY its expense leg — not ITC, AP or the bank", () => {
  const db = stagedDb();
  const b = book(db, 1);
  db.prepare(
    `INSERT INTO parties (company_id, name, kind, gstin, pan, state_code, phone, created_at)
     VALUES (1, 'Gupta Suppliers', 'supplier', '', '', '27', '', @now)`
  ).run({ now: NOW });
  const supplier = (
    db.prepare("SELECT id FROM parties WHERE name = 'Gupta Suppliers'").get() as {
      id: number;
    }
  ).id;
  const cc = createCostCentre(b, { name: "Shop A" });

  const { journalId } = postManualVoucher(b, {
    kind: "purchase",
    entry_date: "2026-07-20",
    memo: "Cloth",
    ref_no: "P-1",
    party_id: supplier,
    amount_paise: 118_000,
    gst_rate: 18,
    bank_account_id: settleId(db, 1, "bank"),
    cost_centre_id: cc,
  });

  const legs = legsOf(db, journalId);
  const tagged = legs.filter((l) => l.cost_centre_id !== null);
  assert.deepEqual(
    tagged.map((l) => l.code),
    ["5000"],
    "only the expense leg carries the centre"
  );
  assert.equal(tagged[0].cost_centre_id, cc);
  // The ones that must NOT carry it, named explicitly: input tax and the
  // supplier control account.
  for (const code of ["1300", "2100"]) {
    const leg = legs.find((l) => l.code === code);
    assert.ok(leg, `expected a ${code} leg`);
    assert.equal(leg!.cost_centre_id, null, `${code} must not carry a cost centre`);
  }
  assert.equal(trialBalance(b).balanced, true);
});

test("a receipt has no income or expense leg, so a centre lands nowhere", () => {
  // The form does not offer one here; this proves the ENGINE also refuses to
  // invent a home for it rather than tagging the bank or AR leg.
  const db = stagedDb();
  const b = book(db, 1);
  const cc = createCostCentre(b, { name: "Shop A" });
  const { journalId } = postManualVoucher(b, {
    kind: "receipt",
    entry_date: "2026-07-20",
    memo: "On account",
    ref_no: "R-1",
    party_id: 1,
    amount_paise: 50_000,
    gst_rate: null,
    bank_account_id: settleId(db, 1, "cash"),
    cost_centre_id: cc,
  });
  assert.deepEqual(
    legsOf(db, journalId).map((l) => l.cost_centre_id),
    [null, null]
  );
});

test("a free-form journal tags its P&L legs and leaves the settlement leg alone", () => {
  const db = stagedDb();
  const b = book(db, 1);
  const cc = createCostCentre(b, { name: "Shop A" });
  const { journalId } = postManualVoucher(b, {
    kind: "journal",
    entry_date: "2026-07-20",
    memo: "Shop rent",
    ref_no: "RENT-07",
    legs: [
      { account_code: "5900", party_id: null, debit_paise: 250_000, credit_paise: 0 },
      { account_code: "1100", party_id: null, debit_paise: 0, credit_paise: 250_000 },
    ],
    cost_centre_id: cc,
  });
  const legs = legsOf(db, journalId);
  assert.equal(legs.find((l) => l.code === "5900")!.cost_centre_id, cc);
  assert.equal(legs.find((l) => l.code === "1100")!.cost_centre_id, null);
});

test("a TDS voucher tags the expense leg only — not TDS payable, not the bank", () => {
  const db = stagedDb();
  const b = book(db, 1);
  db.prepare(
    `INSERT INTO parties (company_id, name, kind, gstin, pan, state_code, phone, created_at)
     VALUES (1, 'Contractor', 'supplier', '', 'ABCPG1234H', '27', '', @now)`
  ).run({ now: NOW });
  const payee = (
    db.prepare("SELECT id FROM parties WHERE name = 'Contractor'").get() as { id: number }
  ).id;
  const cc = createCostCentre(b, { name: "Site 2" });
  const { journalId } = postVoucherWithTds(b, {
    entry_date: "2026-07-20",
    memo: "Shed repair",
    ref_no: "T-1",
    party_id: payee,
    expense_account_code: "5900",
    base_paise: 1_000_000,
    section: "194C",
    bank_account_id: settleId(db, 1, "bank"),
    cost_centre_id: cc,
  });
  const legs = legsOf(db, journalId);
  assert.deepEqual(
    legs.filter((l) => l.cost_centre_id !== null).map((l) => l.code),
    ["5900"]
  );
  assert.equal(legs.find((l) => l.code === "2300")!.cost_centre_id, null);
  assert.equal(trialBalance(b).balanced, true);
});

test("the document path carries a staged row's centre onto its income leg", () => {
  const db = stagedDb();
  const b = book(db, 1);
  const cc = createCostCentre(b, { name: "Shop A" });
  const rows = draftRows(db, [10]).map((r) =>
    r.entry_type === "sale" ? { ...r, cost_centre_id: cc } : r
  );
  postDocument(b, 1, rows);

  const tagged = db
    .prepare(
      `SELECT a.code, a.type, COUNT(*) AS n
       FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
       WHERE jl.cost_centre_id = ? GROUP BY a.code, a.type`
    )
    .all(cc) as { code: string; type: string; n: number }[];
  assert.ok(tagged.length > 0, "at least one line was tagged");
  assert.deepEqual(
    [...new Set(tagged.map((t) => t.type))],
    ["income"],
    "a sale's tag reaches the income leg and nothing else"
  );
  // AR and the GST legs of those same journals stayed untagged.
  const leaked = db
    .prepare(
      `SELECT COUNT(*) AS n FROM journal_lines jl
       JOIN accounts a ON a.id = jl.account_id
       WHERE jl.cost_centre_id IS NOT NULL AND a.type <> 'income' AND a.type <> 'expense'`
    )
    .get() as { n: number };
  assert.equal(leaked.n, 0);
  assert.equal(trialBalance(b).balanced, true);
});

test("tagging changes no figure — the same book, with and without centres", () => {
  const plain = stagedDb();
  postDocument(book(plain, 1), 1, draftRows(plain, [10]));

  const tagged = stagedDb();
  const tb = book(tagged, 1);
  const cc = createCostCentre(tb, { name: "Shop A" });
  postDocument(
    tb,
    1,
    draftRows(tagged, [10]).map((r) => ({ ...r, cost_centre_id: cc }))
  );

  const figures = (db: Database.Database) =>
    db
      .prepare(
        `SELECT a.code, SUM(jl.debit_paise) AS dr, SUM(jl.credit_paise) AS cr
         FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
         WHERE jl.company_id = 1 GROUP BY a.code ORDER BY a.code`
      )
      .all();
  assert.deepEqual(figures(tagged), figures(plain));
  assert.equal(trialBalance(tb).balanced, true);
});

// ---------------------------------------------------------------------------
// Archived: strict for a fresh choice, lax for one already saved
// ---------------------------------------------------------------------------

test("an archived centre is refused for a NEW entry", () => {
  const db = stagedDb();
  const b = book(db, 1);
  const cc = createCostCentre(b, { name: "Closed shop" });
  archiveCostCentre(b, cc, NOW);
  assert.throws(
    () =>
      postManualVoucher(b, {
        kind: "sale",
        entry_date: "2026-07-20",
        memo: "Sale",
        ref_no: "S-1",
        party_id: 1,
        amount_paise: 118_000,
        gst_rate: 18,
        bank_account_id: settleId(db, 1, "cash"),
        cost_centre_id: cc,
      }),
    /archived/
  );
});

test("a document reviewed before the centre was archived still posts", () => {
  // Archiving means "stop offering this", not "history through it is void".
  // Refusing here would strand an already-reviewed document and gain nothing.
  const db = stagedDb();
  const b = book(db, 1);
  const cc = createCostCentre(b, { name: "Shop A" });
  const rows = draftRows(db, [10]).map((r) =>
    r.entry_type === "sale" ? { ...r, cost_centre_id: cc } : r
  );
  b.tx((t) => applyDraftRows(t, 1, rows));
  archiveCostCentre(b, cc, NOW);

  postDocument(b, 1, rows);
  const n = (
    db.prepare("SELECT COUNT(*) AS n FROM journal_lines WHERE cost_centre_id = ?").get(cc) as {
      n: number;
    }
  ).n;
  assert.ok(n > 0, "the archived centre's tag survived onto the journals");
});

test("costCentreUsage counts the lines that would keep pointing at a centre", () => {
  const db = stagedDb();
  const b = book(db, 1);
  const cc = createCostCentre(b, { name: "Shop A" });
  const unused = createCostCentre(b, { name: "Shop B" });
  postDocument(
    b,
    1,
    draftRows(db, [10]).map((r) =>
      r.entry_type === "sale" ? { ...r, cost_centre_id: cc } : r
    )
  );
  const usage = costCentreUsage(b);
  assert.ok((usage.get(cc) ?? 0) > 0);
  assert.equal(usage.get(unused), undefined);
});
