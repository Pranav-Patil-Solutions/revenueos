import { strict as assert } from "node:assert";
import { test } from "node:test";
import type Database from "better-sqlite3";
import { book } from "../src/lib/book";
import { buildLegs } from "../src/lib/posting";
import { postDocument } from "../src/lib/posting";
import { balanceSheet, trialBalance } from "../src/lib/reports";
import { getCompany } from "../src/lib/companies";
import type { PartyRow } from "../src/lib/types";
import { postManualVoucher } from "../src/lib/vouchers";
import { draftRows, postedDb, settleId, stagedDb } from "./helpers";

function journalCount(db: Database.Database): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM journals").get() as { n: number }).n;
}

function legsOf(db: Database.Database, journalId: number) {
  return db
    .prepare(
      `SELECT a.code, jl.party_id, jl.debit_paise, jl.credit_paise
       FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
       WHERE jl.journal_id = ? ORDER BY jl.line_no`
    )
    .all(journalId) as {
    code: string;
    party_id: number | null;
    debit_paise: number;
    credit_paise: number;
  }[];
}

test("structured sale voucher posts exactly buildLegs' output", () => {
  const db = postedDb();
  const b = book(db, 1);
  const { journalId } = postManualVoucher(b, {
    kind: "sale",
    entry_date: "2026-07-20",
    memo: "Manual sale",
    ref_no: "MV-1",
    party_id: 1,
    amount_paise: 118_000, // ₹1,180 gross @ 18%
    gst_rate: 18,
    bank_account_id: settleId(db, 1, "cash"),
  });

  const party = db.prepare("SELECT * FROM parties WHERE id = 1").get() as PartyRow;
  const settings = getCompany(db, 1)!;
  const expected = buildLegs(
    {
      row_no: 0,
      entry_type: "sale",
      debit_paise: 118_000,
      credit_paise: null,
      gst_rate: 18,
    },
    party,
    settings,
    "1000"
  );

  const stored = legsOf(db, journalId);
  assert.equal(stored.length, expected.length);
  expected.forEach((e, i) => {
    assert.equal(stored[i].code, e.accountCode);
    assert.equal(stored[i].party_id, e.partyId);
    assert.equal(stored[i].debit_paise, e.debitPaise);
    assert.equal(stored[i].credit_paise, e.creditPaise);
  });
  const j = db.prepare("SELECT * FROM journals WHERE id = ?").get(journalId) as {
    entry_type: string;
    source_document_id: number | null;
  };
  assert.equal(j.entry_type, "sale");
  assert.equal(j.source_document_id, null, "manual voucher has no document");
});

test("structured voucher rejects a party of the wrong kind", () => {
  const db = postedDb(); // party 1 is a customer
  const b = book(db, 1);
  assert.throws(
    () =>
      postManualVoucher(b, {
        kind: "purchase",
        entry_date: "2026-07-20",
        memo: "",
        ref_no: "",
        party_id: 1,
        amount_paise: 118_000,
        gst_rate: 18,
        bank_account_id: settleId(db, 1, "cash"),
      }),
    /needs a supplier/
  );
});

test("contra moves cash → bank with exact paise", () => {
  const db = postedDb();
  const b = book(db, 1);
  const { journalId } = postManualVoucher(b, {
    kind: "contra",
    entry_date: "2026-07-20",
    memo: "Cash deposited",
    ref_no: "",
    from_bank_account_id: settleId(db, 1, "cash"),
    to_bank_account_id: settleId(db, 1, "bank"),
    amount_paise: 300_000,
  });
  assert.deepEqual(legsOf(db, journalId), [
    { code: "1100", party_id: null, debit_paise: 300_000, credit_paise: 0 },
    { code: "1000", party_id: null, debit_paise: 0, credit_paise: 300_000 },
  ]);
  assert.throws(
    () =>
      postManualVoucher(b, {
        kind: "contra",
        entry_date: "2026-07-20",
        memo: "",
        ref_no: "",
        from_bank_account_id: settleId(db, 1, "cash"),
        to_bank_account_id: settleId(db, 1, "cash"),
        amount_paise: 100,
      }),
    /two different accounts/
  );
});

test("free-form journal: explicit legs post; unbalanced is rejected atomically", () => {
  const db = postedDb();
  const b = book(db, 1);
  const before = journalCount(db);

  const { journalId } = postManualVoucher(b, {
    kind: "journal",
    entry_date: "2026-07-21",
    memo: "Rent",
    ref_no: "",
    legs: [
      { account_code: "5900", party_id: null, debit_paise: 250_000, credit_paise: 0 },
      { account_code: "1100", party_id: null, debit_paise: 0, credit_paise: 250_000 },
    ],
  });
  assert.equal(journalCount(db), before + 1);
  const j = db.prepare("SELECT entry_type FROM journals WHERE id = ?").get(journalId) as {
    entry_type: string;
  };
  assert.equal(j.entry_type, "journal");

  assert.throws(
    () =>
      postManualVoucher(b, {
        kind: "journal",
        entry_date: "2026-07-21",
        memo: "bad",
        ref_no: "",
        legs: [
          { account_code: "5900", party_id: null, debit_paise: 100, credit_paise: 0 },
          { account_code: "1100", party_id: null, debit_paise: 0, credit_paise: 90 },
        ],
      }),
    /does not balance/
  );
  assert.throws(
    () =>
      postManualVoucher(b, {
        kind: "journal",
        entry_date: "2026-07-21",
        memo: "two-sided leg",
        ref_no: "",
        legs: [
          { account_code: "5900", party_id: null, debit_paise: 100, credit_paise: 100 },
          { account_code: "1100", party_id: null, debit_paise: 0, credit_paise: 0 },
        ],
      }),
    /exactly one non-zero side/
  );
  assert.throws(
    () =>
      postManualVoucher(b, {
        kind: "journal",
        entry_date: "2026-07-21",
        memo: "bad code",
        ref_no: "",
        legs: [
          { account_code: "9999", party_id: null, debit_paise: 100, credit_paise: 0 },
          { account_code: "1100", party_id: null, debit_paise: 0, credit_paise: 100 },
        ],
      }),
    /unknown account/
  );
  assert.equal(journalCount(db), before + 1, "failed vouchers left nothing behind");
});

test("books lock rejects back-dated vouchers and document posting", () => {
  const db = postedDb();
  const b = book(db, 1);
  db.prepare("UPDATE companies SET books_locked_through = '2026-07-31' WHERE id = 1").run();

  assert.throws(
    () =>
      postManualVoucher(b, {
        kind: "journal",
        entry_date: "2026-07-15",
        memo: "back-dated",
        ref_no: "",
        legs: [
          { account_code: "5900", party_id: null, debit_paise: 100, credit_paise: 0 },
          { account_code: "1000", party_id: null, debit_paise: 0, credit_paise: 100 },
        ],
      }),
    /locked through 2026-07-31/
  );
  // On the lock date itself: still locked (lock is inclusive).
  assert.throws(
    () =>
      postManualVoucher(b, {
        kind: "contra",
        entry_date: "2026-07-31",
        memo: "",
        ref_no: "",
        from_bank_account_id: settleId(db, 1, "cash"),
        to_bank_account_id: settleId(db, 1, "bank"),
        amount_paise: 100,
      }),
    /locked/
  );
  // First open day posts fine.
  postManualVoucher(b, {
    kind: "contra",
    entry_date: "2026-08-01",
    memo: "",
    ref_no: "",
    from_bank_account_id: settleId(db, 1, "cash"),
    to_bank_account_id: settleId(db, 1, "bank"),
    amount_paise: 100,
  });

  // The document path hits the same guard (fixture rows are July-dated).
  const staged = stagedDb();
  const bStaged = book(staged, 1);
  staged
    .prepare("UPDATE companies SET books_locked_through = '2026-07-31' WHERE id = 1")
    .run();
  assert.throws(() => postDocument(bStaged, 1, draftRows(staged, [10])), /locked/);
});

test("mixed manual batch keeps TB at zero and the BS balanced", () => {
  const db = postedDb();
  const b = book(db, 1);
  postManualVoucher(b, {
    kind: "sale",
    entry_date: "2026-08-03",
    memo: "s",
    ref_no: "",
    party_id: 1,
    amount_paise: 59_000,
    gst_rate: 18,
    bank_account_id: settleId(db, 1, "cash"),
  });
  postManualVoucher(b, {
    kind: "receipt",
    entry_date: "2026-08-04",
    memo: "r",
    ref_no: "",
    party_id: 1,
    amount_paise: 59_000,
    gst_rate: null,
    bank_account_id: settleId(db, 1, "bank"),
  });
  postManualVoucher(b, {
    kind: "contra",
    entry_date: "2026-08-05",
    memo: "c",
    ref_no: "",
    from_bank_account_id: settleId(db, 1, "bank"),
    to_bank_account_id: settleId(db, 1, "cash"),
    amount_paise: 25_000,
  });
  postManualVoucher(b, {
    kind: "journal",
    entry_date: "2026-08-06",
    memo: "j",
    ref_no: "",
    legs: [
      { account_code: "5900", party_id: null, debit_paise: 10_000, credit_paise: 0 },
      { account_code: "1000", party_id: null, debit_paise: 0, credit_paise: 10_000 },
    ],
  });

  const tb = trialBalance(b);
  assert.equal(tb.balanced, true);
  const settings = getCompany(db, 1)!;
  const bs = balanceSheet(b, "2027-03-31", settings);
  assert.equal(bs.balanced, true);
});
