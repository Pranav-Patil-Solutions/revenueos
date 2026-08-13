import { strict as assert } from "node:assert";
import { test } from "node:test";
import type Database from "better-sqlite3";
import { book } from "../src/lib/book";
import { buildLegs } from "../src/lib/posting";
import { postDocument } from "../src/lib/posting";
import { balanceSheet, trialBalance } from "../src/lib/reports";
import { createBankAccount, listBankAccounts } from "../src/lib/bank-accounts";
import { createCompany, getCompany } from "../src/lib/companies";
import { seedAccountsForCompany } from "../src/lib/db";
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

/**
 * Regression — found in a browser, not by any gate here (RVOS-006 P0c).
 *
 * P0a replaced a lenient `settle_account` parse (a missing field silently
 * defaulted to 'cash') with one that DEMANDS a `bank_account_id` for every
 * structured voucher. But the form only renders that select for receipt and
 * payment, because those are the only kinds that settle through an account —
 * so from P0a until this fix, every manual sale, purchase, credit note and
 * debit note threw "Pick a cash or bank account for this voucher" and could
 * not be posted at all.
 *
 * No unit test could see it: they all pass a real id straight to
 * postManualVoucher, and the smoke's manual legs are journal/contra kinds. The
 * defect lived in the seam between the form and the action. These two tests
 * pin both halves of the rule.
 */
test("a sale, purchase or note posts with NO settlement account — they settle nothing", () => {
  const db = postedDb();
  const b = book(db, 1);
  const before = journalCount(db);
  const { journalId } = postManualVoucher(b, {
    kind: "sale",
    entry_date: "2026-07-21",
    memo: "Credit sale",
    ref_no: "MV-NOBANK",
    party_id: 1,
    amount_paise: 118_000,
    gst_rate: 18,
    bank_account_id: null,
  });
  assert.equal(journalCount(db), before + 1);
  const codes = legsOf(db, journalId).map((l) => l.code);
  assert.deepEqual(codes, ["1200", "4000", "2200", "2210"]);
  assert.equal(trialBalance(b).balanced, true);
});

test("a receipt without a settlement account is refused, naming what is missing", () => {
  const db = postedDb();
  assert.throws(
    () =>
      postManualVoucher(book(db, 1), {
        kind: "receipt",
        entry_date: "2026-07-21",
        memo: "Cash in",
        ref_no: "MV-R",
        party_id: 1,
        amount_paise: 50_000,
        gst_rate: null,
        bank_account_id: null,
      }),
    /receipt needs the cash or bank account/
  );
  assert.equal(journalCount(db), 9, "the refusal left the books untouched");
});

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

/**
 * The case the old enum made unrepresentable — RVOS-006 P0a.
 *
 * `settle_account` had exactly two values, so "move money from the current
 * account to the OD account" could not be expressed at all: both ends resolved
 * to ledger 1100 and the contra would have been refused as same-account. This
 * is the transfer an office actually performs most often, and it stayed
 * unverified when P0a shipped.
 */
test("contra moves money bank → bank between two real accounts, each on its own ledger", () => {
  const db = postedDb();
  const b = book(db, 1);
  const seededBank = settleId(db, 1, "bank"); // ledger 1100
  const second = createBankAccount(b, { name: "ICICI OD", kind: "bank" });
  const secondCode = listBankAccounts(b).find((a) => a.id === second)!.account_code;
  assert.equal(secondCode, "1110", "allocated in the bank range, not reusing 1100");

  const before = trialBalance(b);
  const { journalId } = postManualVoucher(b, {
    kind: "contra",
    entry_date: "2026-07-21",
    memo: "Sweep to OD",
    ref_no: "SWEEP-1",
    from_bank_account_id: seededBank,
    to_bank_account_id: second,
    amount_paise: 250_000,
  });

  // Two DIFFERENT ledgers move. Under the old enum both legs would have been
  // 1100 and this voucher could not exist.
  assert.deepEqual(legsOf(db, journalId), [
    { code: "1110", party_id: null, debit_paise: 250_000, credit_paise: 0 },
    { code: "1100", party_id: null, debit_paise: 0, credit_paise: 250_000 },
  ]);

  // A contra is INTERNAL: money the business already had moves between two of
  // its own asset ledgers. So the trial-balance totals must be completely
  // unchanged — not merely still balanced. One ledger loses exactly what the
  // other gains, so nothing is added to or removed from the books, and a
  // transfer can never read as new income or a new liability.
  const after = trialBalance(b);
  assert.equal(after.balanced, true);
  assert.equal(
    after.total_debit_paise - before.total_debit_paise,
    0,
    "an internal transfer must not change the totals at all"
  );
  assert.equal(after.total_credit_paise - before.total_credit_paise, 0);
  const net = (code: string) =>
    (
      db
        .prepare(
          `SELECT COALESCE(SUM(jl.debit_paise) - SUM(jl.credit_paise), 0) AS n
           FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
           WHERE a.code = ? AND a.company_id = 1 AND jl.company_id = 1`
        )
        .get(code) as { n: number }
    ).n;
  assert.equal(net("1110"), 250_000, "the receiving account gained exactly the transfer");
});

test("contra refuses an account belonging to another company", () => {
  const db = postedDb();
  const other = createCompany(db, { name: "Client B" }, "2026-07-01T00:00:00Z");
  seedAccountsForCompany(db, other);
  const foreign = settleId(db, other, "bank");
  assert.throws(
    () =>
      postManualVoucher(book(db, 1), {
        kind: "contra",
        entry_date: "2026-07-21",
        memo: "",
        ref_no: "",
        from_bank_account_id: settleId(db, 1, "cash"),
        to_bank_account_id: foreign,
        amount_paise: 100,
      }),
    /does not exist in this book/
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
