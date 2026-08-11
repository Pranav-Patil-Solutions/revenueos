import { strict as assert } from "node:assert";
import { test } from "node:test";
import Database from "better-sqlite3";
import { book } from "../src/lib/book";
import { archiveBankAccount, createBankAccount, defaultForHint } from "../src/lib/bank-accounts";
import { initSchema, seedCoreData } from "../src/lib/db";
import { migrate } from "../src/lib/migrate";
import { MIGRATIONS } from "../src/lib/migrations";
import { validateExtraction } from "../src/lib/extraction-schema";
import { DEMO_FIXTURE } from "../src/lib/extraction";
import { assertBalanced, buildLegs, postDocument, type Leg } from "../src/lib/posting";
import type { DraftRowInput, StagedRow } from "../src/lib/types";

const CUSTOMER = { id: 1, kind: "customer" as const, state_code: "27" };
const SUPPLIER = { id: 2, kind: "supplier" as const, state_code: "07" };
const SETTINGS = { state_code: "27", default_gst_rate: 18, tax_inclusive: 1 };
// buildLegs now takes the resolved settlement LEDGER CODE rather than a
// cash/bank enum (RVOS-006 P0a). These are the seeded two; the point of the
// change is that a book may have many more.
const CASH = "1000";
const BANK = "1100";

function row(overrides: Record<string, unknown>) {
  return {
    row_no: 1,
    entry_type: "sale",
    debit_paise: null,
    credit_paise: null,
    gst_rate: null,
    ...overrides,
  } as Parameters<typeof buildLegs>[0];
}

function byCode(legs: Leg[], code: string): Leg {
  const l = legs.find((x) => x.accountCode === code);
  assert.ok(l, `expected a leg on account ${code}`);
  return l;
}

test("sale (intra-state, inclusive): AR gross, Sales taxable, CGST+SGST", () => {
  const legs = buildLegs(row({ entry_type: "sale", debit_paise: 118_000, gst_rate: 18 }), CUSTOMER, SETTINGS, CASH);
  assertBalanced(legs);
  assert.equal(byCode(legs, "1200").debitPaise, 118_000);
  assert.equal(byCode(legs, "1200").partyId, 1); // party stamped on the control line
  assert.equal(byCode(legs, "4000").creditPaise, 100_000);
  assert.equal(byCode(legs, "2200").creditPaise, 9_000);
  assert.equal(byCode(legs, "2210").creditPaise, 9_000);
});

test("sale (inter-state): single IGST leg", () => {
  const interCustomer = { id: 3, kind: "customer" as const, state_code: "07" };
  const legs = buildLegs(row({ entry_type: "sale", debit_paise: 118_000, gst_rate: 18 }), interCustomer, SETTINGS, CASH);
  assertBalanced(legs);
  assert.equal(byCode(legs, "2220").creditPaise, 18_000);
  assert.ok(!legs.some((l) => l.accountCode === "2200" || l.accountCode === "2210"));
});

test("sale with odd-paise tax still balances to the exact gross", () => {
  const legs = buildLegs(row({ entry_type: "sale", debit_paise: 101, gst_rate: 18 }), CUSTOMER, SETTINGS, CASH);
  assertBalanced(legs); // taxable 86 + cgst 8 + sgst 7 = 101
  const total = legs.reduce((s, l) => s + l.creditPaise, 0);
  assert.equal(total, 101);
});

test("receipt: settle account by cash/bank, no GST", () => {
  const cash = buildLegs(row({ entry_type: "receipt", credit_paise: 700_000 }), CUSTOMER, SETTINGS, CASH);
  assertBalanced(cash);
  assert.equal(byCode(cash, "1000").debitPaise, 700_000);
  assert.equal(byCode(cash, "1200").creditPaise, 700_000);
  assert.equal(cash.length, 2);

  const bank = buildLegs(row({ entry_type: "receipt", credit_paise: 400_000 }), CUSTOMER, SETTINGS, BANK);
  assert.equal(byCode(bank, "1100").debitPaise, 400_000);
});

test("purchase: Purchases + ITC against AP gross", () => {
  const legs = buildLegs(row({ entry_type: "purchase", credit_paise: 590_000, gst_rate: 18 }), CUSTOMER, SETTINGS, CASH);
  assertBalanced(legs);
  assert.equal(byCode(legs, "5000").debitPaise, 500_000);
  assert.equal(byCode(legs, "1300").debitPaise, 90_000);
  assert.equal(byCode(legs, "2100").creditPaise, 590_000);
  assert.equal(byCode(legs, "2100").partyId, 1);
});

test("payment: AP debit against cash/bank credit", () => {
  const legs = buildLegs(row({ entry_type: "payment", debit_paise: 200_000 }), SUPPLIER, SETTINGS, CASH);
  assertBalanced(legs);
  assert.equal(byCode(legs, "2100").debitPaise, 200_000);
  assert.equal(byCode(legs, "1000").creditPaise, 200_000);
});

test("credit_note is the exact reverse of sale", () => {
  const sale = buildLegs(row({ entry_type: "sale", debit_paise: 118_000, gst_rate: 18 }), CUSTOMER, SETTINGS, CASH);
  const cn = buildLegs(row({ entry_type: "credit_note", credit_paise: 118_000, gst_rate: 18 }), CUSTOMER, SETTINGS, CASH);
  assertBalanced(cn);
  for (const s of sale) {
    const r = byCode(cn, s.accountCode);
    assert.equal(r.debitPaise, s.creditPaise, s.accountCode);
    assert.equal(r.creditPaise, s.debitPaise, s.accountCode);
  }
});

test("debit_note is the exact reverse of purchase", () => {
  const purchase = buildLegs(row({ entry_type: "purchase", credit_paise: 590_000, gst_rate: 18 }), SUPPLIER, SETTINGS, CASH);
  const dn = buildLegs(row({ entry_type: "debit_note", debit_paise: 590_000, gst_rate: 18 }), SUPPLIER, SETTINGS, CASH);
  assertBalanced(dn);
  for (const p of purchase) {
    const r = byCode(dn, p.accountCode);
    assert.equal(r.debitPaise, p.creditPaise, p.accountCode);
    assert.equal(r.creditPaise, p.debitPaise, p.accountCode);
  }
});

test("opening: control account by party kind, direction by ledger column", () => {
  const custDr = buildLegs(row({ entry_type: "opening", debit_paise: 500_000 }), CUSTOMER, SETTINGS, CASH);
  assert.equal(byCode(custDr, "1200").debitPaise, 500_000);
  assert.equal(byCode(custDr, "3000").creditPaise, 500_000);

  const custCr = buildLegs(row({ entry_type: "opening", credit_paise: 40_000 }), CUSTOMER, SETTINGS, CASH);
  assert.equal(byCode(custCr, "1200").creditPaise, 40_000);
  assert.equal(byCode(custCr, "3000").debitPaise, 40_000);

  const suppCr = buildLegs(row({ entry_type: "opening", credit_paise: 90_000 }), SUPPLIER, SETTINGS, CASH);
  assert.equal(byCode(suppCr, "2100").creditPaise, 90_000);
  assert.equal(byCode(suppCr, "3000").debitPaise, 90_000);
});

test("gst_rate falls back to the settings default", () => {
  const legs = buildLegs(row({ entry_type: "sale", debit_paise: 118_000 }), CUSTOMER, SETTINGS, CASH);
  assert.equal(byCode(legs, "4000").creditPaise, 100_000); // default 18 applied
});

test("rate 0 emits no tax legs", () => {
  const legs = buildLegs(row({ entry_type: "sale", debit_paise: 100_000, gst_rate: 0 }), CUSTOMER, SETTINGS, CASH);
  assert.equal(legs.length, 2);
  assert.equal(byCode(legs, "4000").creditPaise, 100_000);
});

test("tax-exclusive settings add GST on top", () => {
  const legs = buildLegs(
    row({ entry_type: "sale", debit_paise: 100_000, gst_rate: 18 }),
    CUSTOMER,
    { ...SETTINGS, tax_inclusive: 0 },
    CASH
  );
  assertBalanced(legs);
  assert.equal(byCode(legs, "1200").debitPaise, 118_000);
  assert.equal(byCode(legs, "4000").creditPaise, 100_000);
});

test("'other' rows are unpostable", () => {
  assert.throws(
    () => buildLegs(row({ entry_type: "other", debit_paise: 100 }), CUSTOMER, SETTINGS, CASH),
    /unpostable/
  );
});

test("a row with both sides (or neither) throws", () => {
  assert.throws(() => buildLegs(row({ debit_paise: 1, credit_paise: 1 }), CUSTOMER, SETTINGS, CASH), /exactly one/);
  assert.throws(() => buildLegs(row({}), CUSTOMER, SETTINGS, CASH), /exactly one/);
});

test("assertBalanced rejects tampered legs and non-integer paise", () => {
  assert.throws(
    () =>
      assertBalanced([
        { accountCode: "1200", partyId: null, debitPaise: 100, creditPaise: 0 },
        { accountCode: "4000", partyId: null, debitPaise: 0, creditPaise: 99 },
      ]),
    /does not balance/
  );
  assert.throws(
    () =>
      assertBalanced([
        { accountCode: "1200", partyId: null, debitPaise: 0.5, creditPaise: 0 },
        { accountCode: "4000", partyId: null, debitPaise: 0, creditPaise: 0.5 },
      ]),
    /non-integer/
  );
});

// ---------------------------------------------------------------------------
// postDocument against a real (in-memory) db
// ---------------------------------------------------------------------------

function setupDb(): Database.Database {
  const db = new Database(":memory:");
  initSchema(db);
  seedCoreData(db);
  migrate(db, MIGRATIONS, { now: "2026-01-01T00:00:00.000Z" });
  db.prepare(
    `INSERT INTO parties (name, kind, gstin, state_code, phone, created_at)
     VALUES ('Sharma Traders', 'customer', '', '27', '', '2026-07-01T00:00:00Z')`
  ).run();
  db.prepare(
    `INSERT INTO documents (party_id, image_path, image_sha256, status, created_at)
     VALUES (1, 'data/uploads/demo.jpg', 'demo-sha', 'extracted', '2026-07-16T00:00:00Z')`
  ).run();
  const insert = db.prepare(
    `INSERT INTO staged_rows
       (document_id, row_no, entry_date, particulars, ref_no, debit_paise, credit_paise,
        entry_type, gst_rate, bank_account_id, confidence, is_balance_row, include)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const hintTo = (hint: "cash" | "bank"): number =>
    defaultForHint(book(db, 1), hint).id;
  for (const r of validateExtraction(DEMO_FIXTURE).rows) {
    insert.run(
      r.row_no, r.entry_date, r.particulars, r.ref_no, r.debit_paise, r.credit_paise,
      r.entry_type, r.gst_rate, hintTo(r.settle_hint), r.confidence,
      r.is_balance_row ? 1 : 0, r.include ? 1 : 0
    );
  }
  return db;
}

function draftsFromStaged(db: Database.Database, excludeRowNos: number[] = []): DraftRowInput[] {
  const staged = db
    .prepare("SELECT * FROM staged_rows WHERE document_id = 1 ORDER BY row_no")
    .all() as StagedRow[];
  return staged.map((r) => ({
    id: r.id,
    entry_date: r.entry_date,
    particulars: r.particulars,
    ref_no: r.ref_no,
    debit_paise: r.debit_paise,
    credit_paise: r.credit_paise,
    entry_type: r.entry_type,
    gst_rate: r.gst_rate,
    bank_account_id: r.bank_account_id,
    include: excludeRowNos.includes(r.row_no) ? false : r.include === 1,
  }));
}

test("postDocument: demo fixture posts 9 journals, books balance, AR = ₹12,580.00", () => {
  const db = setupDb();
  const b = book(db, 1);
  const { journals } = postDocument(b, 1, draftsFromStaged(db, [10]));
  assert.equal(journals, 9);

  const sum = db
    .prepare("SELECT SUM(debit_paise) - SUM(credit_paise) AS d FROM journal_lines")
    .get() as { d: number };
  assert.equal(sum.d, 0);

  const ar = db
    .prepare(
      `SELECT SUM(jl.debit_paise) - SUM(jl.credit_paise) AS bal
       FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
       WHERE a.code = '1200' AND jl.party_id = 1`
    )
    .get() as { bal: number };
  assert.equal(ar.bal, 1_258_000); // ₹12,580.00

  const doc = db.prepare("SELECT status, posted_at FROM documents WHERE id = 1").get() as {
    status: string;
    posted_at: string | null;
  };
  assert.equal(doc.status, "posted");
  assert.ok(doc.posted_at);

  const unstamped = db
    .prepare(
      "SELECT COUNT(*) AS n FROM staged_rows WHERE include = 1 AND posted_journal_id IS NULL"
    )
    .get() as { n: number };
  assert.equal(unstamped.n, 0);
});

test("postDocument: double-post throws (idempotency re-check inside the tx)", () => {
  const db = setupDb();
  const b = book(db, 1);
  postDocument(b, 1, draftsFromStaged(db, [10]));
  assert.throws(() => postDocument(b, 1, draftsFromStaged(db, [10])), /already posted/);
});

test("postDocument: an included 'other' row aborts and rolls back everything", () => {
  const db = setupDb();
  const b = book(db, 1);
  // Give the 'other' row an amount so it fails specifically as unpostable
  // (amountless rows are caught earlier by the one-non-zero-side check).
  const drafts = draftsFromStaged(db).map((d, i) =>
    i === 9 ? { ...d, debit_paise: 100_000 } : d
  );
  assert.throws(() => postDocument(b, 1, drafts), /unpostable/);
  const journals = db.prepare("SELECT COUNT(*) AS n FROM journals").get() as { n: number };
  assert.equal(journals.n, 0);
  const doc = db.prepare("SELECT status FROM documents WHERE id = 1").get() as { status: string };
  assert.equal(doc.status, "extracted"); // status flip rolled back too
});

test("postDocument: a dateless included row aborts the whole post", () => {
  const db = setupDb();
  const b = book(db, 1);
  const drafts = draftsFromStaged(db, [10]).map((d, i) =>
    i === 2 ? { ...d, entry_date: null } : d
  );
  assert.throws(() => postDocument(b, 1, drafts), /needs a date/);
  const journals = db.prepare("SELECT COUNT(*) AS n FROM journals").get() as { n: number };
  assert.equal(journals.n, 0);
});

test("postDocument: staged party_id overrides the doc party per row; NULL falls back", () => {
  const db = setupDb();
  const b = book(db, 1);
  db.prepare(
    `INSERT INTO parties (name, kind, gstin, state_code, phone, created_at)
     VALUES ('Gupta Suppliers', 'supplier', '', '07', '', '2026-07-01T00:00:00Z')`
  ).run();
  // Fresh doc for Sharma (id 1) with two rows: a sale with party_id NULL
  // (doc fallback → Sharma) and a purchase booked to Gupta (id 2) per row.
  db.prepare(
    `INSERT INTO documents (party_id, image_path, image_sha256, status, source_type, created_at)
     VALUES (1, 'data/uploads/import.csv', 'csv-sha', 'extracted', 'excel', '2026-07-16T00:00:00Z')`
  ).run();
  const cashId = defaultForHint(book(db, 1), "cash").id;
  const bankId = defaultForHint(book(db, 1), "bank").id;
  db.prepare(
    `INSERT INTO staged_rows
       (document_id, row_no, entry_date, particulars, ref_no, debit_paise, credit_paise,
        entry_type, gst_rate, bank_account_id, confidence, is_balance_row, include, party_id)
     VALUES (2, 1, '2026-07-02', 'Cloth bill', '241', 1180000, NULL, 'sale', 18, @cashId, 1, 0, 1, NULL),
            (2, 2, '2026-07-14', 'Packing inv 88', '88', NULL, 590000, 'purchase', 18, @bankId, 1, 0, 1, 2)`
  ).run({ cashId, bankId });

  const staged = db
    .prepare("SELECT * FROM staged_rows WHERE document_id = 2 ORDER BY row_no")
    .all() as StagedRow[];
  const drafts: DraftRowInput[] = staged.map((r) => ({
    id: r.id,
    entry_date: r.entry_date,
    particulars: r.particulars,
    ref_no: r.ref_no,
    debit_paise: r.debit_paise,
    credit_paise: r.credit_paise,
    entry_type: r.entry_type,
    gst_rate: r.gst_rate,
    bank_account_id: r.bank_account_id,
    include: true,
  }));
  const { journals } = postDocument(b, 2, drafts);
  assert.equal(journals, 2);

  const sum = db
    .prepare("SELECT SUM(debit_paise) - SUM(credit_paise) AS d FROM journal_lines")
    .get() as { d: number };
  assert.equal(sum.d, 0);

  // Sale row (NULL party) landed on Sharma's AR — the photo-path fallback.
  const ar = db
    .prepare(
      `SELECT SUM(jl.debit_paise) - SUM(jl.credit_paise) AS bal
       FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
       WHERE a.code = '1200' AND jl.party_id = 1`
    )
    .get() as { bal: number };
  assert.equal(ar.bal, 1_180_000);

  // Purchase row's per-row party landed on Gupta's AP, inter-state doesn't
  // apply to inclusive ITC math here: AP gross 5900, ITC 900.
  const ap = db
    .prepare(
      `SELECT SUM(jl.credit_paise) - SUM(jl.debit_paise) AS bal
       FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
       WHERE a.code = '2100' AND jl.party_id = 2`
    )
    .get() as { bal: number };
  assert.equal(ap.bal, 590_000);

  // No AP line ever carries the doc party — the override is per row, not doc-wide.
  const wrong = db
    .prepare(
      `SELECT COUNT(*) AS n FROM journal_lines jl
       JOIN accounts a ON a.id = jl.account_id
       WHERE a.code = '2100' AND jl.party_id = 1`
    )
    .get() as { n: number };
  assert.equal(wrong.n, 0);
});

test("postDocument: three rows on THREE different bank_account_ids each settle on their OWN ledger code, not each other's", () => {
  // The two-seeded-accounts tests above (cash id vs bank id) don't prove the
  // per-row resolution is actually keyed by id rather than by kind — with only
  // two accounts a bug that resolved "whichever bank account is default" would
  // still pass. A THIRD, freshly created bank account closes that gap.
  const db = setupDb();
  const b = book(db, 1);
  const cashId = defaultForHint(b, "cash").id;
  const bankId = defaultForHint(b, "bank").id;
  const hdfcId = createBankAccount(b, { name: "HDFC Current", kind: "bank" });

  db.prepare(
    `INSERT INTO documents (party_id, image_path, image_sha256, status, source_type, created_at)
     VALUES (1, 'data/uploads/import.csv', 'csv-sha', 'extracted', 'excel', '2026-07-16T00:00:00Z')`
  ).run();
  db.prepare(
    `INSERT INTO staged_rows
       (document_id, row_no, entry_date, particulars, ref_no, debit_paise, credit_paise,
        entry_type, gst_rate, bank_account_id, confidence, is_balance_row, include)
     VALUES (2, 1, '2026-07-02', 'Receipt via cash', 'r1', 100000, NULL, 'receipt', 0, @cashId, 1, 0, 1),
            (2, 2, '2026-07-03', 'Receipt via bank', 'r2', 200000, NULL, 'receipt', 0, @bankId, 1, 0, 1),
            (2, 3, '2026-07-04', 'Receipt via HDFC', 'r3', 300000, NULL, 'receipt', 0, @hdfcId, 1, 0, 1)`
  ).run({ cashId, bankId, hdfcId });

  const drafts = (
    db.prepare("SELECT * FROM staged_rows WHERE document_id = 2 ORDER BY row_no").all() as StagedRow[]
  ).map((r) => ({
    id: r.id,
    entry_date: r.entry_date,
    particulars: r.particulars,
    ref_no: r.ref_no,
    debit_paise: r.debit_paise,
    credit_paise: r.credit_paise,
    entry_type: r.entry_type,
    gst_rate: r.gst_rate,
    bank_account_id: r.bank_account_id,
    include: true,
  }));
  const { journals } = postDocument(b, 2, drafts);
  assert.equal(journals, 3);

  const legFor = (refNo: string) =>
    db
      .prepare(
        `SELECT a.code FROM journal_lines jl
         JOIN accounts a ON a.id = jl.account_id
         JOIN journals j ON j.id = jl.journal_id
         WHERE j.ref_no = ? AND a.code != '1200'`
      )
      .get(refNo) as { code: string };

  assert.equal(legFor("r1").code, "1000"); // cash
  assert.equal(legFor("r2").code, "1100"); // seeded bank
  assert.equal(legFor("r3").code, "1110"); // the new HDFC ledger — first free ten past 1100
});

test("postDocument: a bank_account_id archived AFTER staging but BEFORE posting still posts to its ledger (deliberate — see postDocument's settleCodes comment)", () => {
  const db = setupDb();
  const b = book(db, 1);
  const bankId = defaultForHint(b, "bank").id;
  // Archiving refuses to remove the last account of a kind, so a sibling must
  // exist first — mirrors how this state would actually arise: the office
  // opens a new current account and archives the old one mid-review.
  createBankAccount(b, { name: "New Current A/c", kind: "bank" });
  archiveBankAccount(b, bankId, "2026-07-20T00:00:00.000Z");

  db.prepare(
    `INSERT INTO documents (party_id, image_path, image_sha256, status, source_type, created_at)
     VALUES (1, 'data/uploads/import.csv', 'csv-sha', 'extracted', 'excel', '2026-07-16T00:00:00Z')`
  ).run();
  db.prepare(
    `INSERT INTO staged_rows
       (document_id, row_no, entry_date, particulars, ref_no, debit_paise, credit_paise,
        entry_type, gst_rate, bank_account_id, confidence, is_balance_row, include)
     VALUES (2, 1, '2026-07-21', 'Receipt against the now-archived account', 'r1', 150000, NULL, 'receipt', 0, @bankId, 1, 0, 1)`
  ).run({ bankId });

  const drafts = (
    db.prepare("SELECT * FROM staged_rows WHERE document_id = 2 ORDER BY row_no").all() as StagedRow[]
  ).map((r) => ({
    id: r.id,
    entry_date: r.entry_date,
    particulars: r.particulars,
    ref_no: r.ref_no,
    debit_paise: r.debit_paise,
    credit_paise: r.credit_paise,
    entry_type: r.entry_type,
    gst_rate: r.gst_rate,
    bank_account_id: r.bank_account_id,
    include: true,
  }));

  const { journals } = postDocument(b, 2, drafts);
  assert.equal(journals, 1);

  const leg = db
    .prepare(
      `SELECT a.code FROM journal_lines jl
       JOIN accounts a ON a.id = jl.account_id
       WHERE jl.account_id != (SELECT id FROM accounts WHERE code = '1200' AND company_id = 1)`
    )
    .get() as { code: string };
  assert.equal(leg.code, "1100"); // still posts through the archived account's own ledger
});
