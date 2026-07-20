import { strict as assert } from "node:assert";
import { test } from "node:test";
import Database from "better-sqlite3";
import { initSchema, seedCoreData } from "../src/lib/db";
import {
  parseDayBook,
  suggestTarget,
  tallyVouchersToRows,
  unmappedLedgers,
  type LedgerMapping,
  type MappedAccount,
} from "../src/lib/import-tally";
import { postDocument } from "../src/lib/posting";
import type { DraftRowInput, StagedRow } from "../src/lib/types";

/** A Day Book with one of each shape that matters: a GST sale, a bank
 * receipt, a cash payment, and a multi-ledger journal that must NOT post. */
const DAY_BOOK = `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
 <HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER>
 <BODY><IMPORTDATA>
  <REQUESTDESC><REPORTNAME>Day Book</REPORTNAME></REQUESTDESC>
  <REQUESTDATA>
   <TALLYMESSAGE>
    <VOUCHER VCHTYPE="Sales" ACTION="Create">
     <DATE>20260802</DATE>
     <VOUCHERTYPENAME>Sales</VOUCHERTYPENAME>
     <VOUCHERNUMBER>301</VOUCHERNUMBER>
     <NARRATION>Cloth bill #301</NARRATION>
     <ALLLEDGERENTRIES.LIST><LEDGERNAME>Sharma Traders</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-11800.00</AMOUNT></ALLLEDGERENTRIES.LIST>
     <ALLLEDGERENTRIES.LIST><LEDGERNAME>Sales Account</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>10000.00</AMOUNT></ALLLEDGERENTRIES.LIST>
     <ALLLEDGERENTRIES.LIST><LEDGERNAME>Output CGST</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>900.00</AMOUNT></ALLLEDGERENTRIES.LIST>
     <ALLLEDGERENTRIES.LIST><LEDGERNAME>Output SGST</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>900.00</AMOUNT></ALLLEDGERENTRIES.LIST>
    </VOUCHER>
    <VOUCHER VCHTYPE="Receipt" ACTION="Create">
     <DATE>20260805</DATE>
     <VOUCHERTYPENAME>Receipt</VOUCHERTYPENAME>
     <VOUCHERNUMBER>R-9</VOUCHERNUMBER>
     <NARRATION>Part payment against #301</NARRATION>
     <ALLLEDGERENTRIES.LIST><LEDGERNAME>Bank of Baroda</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-5000.00</AMOUNT></ALLLEDGERENTRIES.LIST>
     <ALLLEDGERENTRIES.LIST><LEDGERNAME>Sharma Traders</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>5000.00</AMOUNT></ALLLEDGERENTRIES.LIST>
    </VOUCHER>
    <VOUCHER VCHTYPE="Payment" ACTION="Create">
     <DATE>20260806</DATE>
     <VOUCHERTYPENAME>Payment</VOUCHERTYPENAME>
     <VOUCHERNUMBER>P-4</VOUCHERNUMBER>
     <NARRATION>Paid Gupta in cash</NARRATION>
     <ALLLEDGERENTRIES.LIST><LEDGERNAME>Gupta Suppliers</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-2360.00</AMOUNT></ALLLEDGERENTRIES.LIST>
     <ALLLEDGERENTRIES.LIST><LEDGERNAME>Cash</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>2360.00</AMOUNT></ALLLEDGERENTRIES.LIST>
    </VOUCHER>
    <VOUCHER VCHTYPE="Journal" ACTION="Create">
     <DATE>20260809</DATE>
     <VOUCHERTYPENAME>Journal</VOUCHERTYPENAME>
     <VOUCHERNUMBER>J-2</VOUCHERNUMBER>
     <NARRATION>Rent accrual and depreciation</NARRATION>
     <ALLLEDGERENTRIES.LIST><LEDGERNAME>Rent</LEDGERNAME><AMOUNT>-2500.00</AMOUNT></ALLLEDGERENTRIES.LIST>
     <ALLLEDGERENTRIES.LIST><LEDGERNAME>Depreciation</LEDGERNAME><AMOUNT>-1500.00</AMOUNT></ALLLEDGERENTRIES.LIST>
     <ALLLEDGERENTRIES.LIST><LEDGERNAME>Outstanding Rent</LEDGERNAME><AMOUNT>2500.00</AMOUNT></ALLLEDGERENTRIES.LIST>
     <ALLLEDGERENTRIES.LIST><LEDGERNAME>Accumulated Depreciation</LEDGERNAME><AMOUNT>1500.00</AMOUNT></ALLLEDGERENTRIES.LIST>
    </VOUCHER>
   </TALLYMESSAGE>
  </REQUESTDATA>
 </IMPORTDATA></BODY>
</ENVELOPE>`;

const SHARMA = 1;
const GUPTA = 2;

/** Ledger → target for the fixture, as the mapping form would save it. */
const MAPPINGS: LedgerMapping[] = [
  { ledger_name: "Sharma Traders", target_kind: "party", account_id: null, party_id: SHARMA },
  { ledger_name: "Gupta Suppliers", target_kind: "party", account_id: null, party_id: GUPTA },
  { ledger_name: "Sales Account", target_kind: "account", account_id: 101, party_id: null },
  { ledger_name: "Output CGST", target_kind: "account", account_id: 102, party_id: null },
  { ledger_name: "Output SGST", target_kind: "account", account_id: 103, party_id: null },
  { ledger_name: "Bank of Baroda", target_kind: "account", account_id: 104, party_id: null },
  { ledger_name: "Cash", target_kind: "account", account_id: 105, party_id: null },
];

const ACCOUNTS: MappedAccount[] = [
  { id: 101, code: "4000", type: "income" }, // Sales
  { id: 102, code: "2200", type: "liability" }, // Output CGST
  { id: 103, code: "2210", type: "liability" }, // Output SGST
  { id: 104, code: "1100", type: "asset" }, // Bank
  { id: 105, code: "1000", type: "asset" }, // Cash
  { id: 106, code: "5900", type: "expense" }, // Expenses — a non-revenue leg
  { id: 107, code: "1530", type: "asset" }, // Computers — a fixed asset
];

const INCLUSIVE = { taxInclusive: true };

function convert(
  xml = DAY_BOOK,
  mappings = MAPPINGS,
  options = INCLUSIVE
) {
  return tallyVouchersToRows(parseDayBook(xml), mappings, ACCOUNTS, options);
}

// ---------------------------------------------------------------------------
// parseDayBook — structure and exact paise
// ---------------------------------------------------------------------------

test("parseDayBook: vouchers in file order, Tally sign convention, exact paise", () => {
  const vouchers = parseDayBook(DAY_BOOK);
  assert.equal(vouchers.length, 4);
  assert.deepEqual(
    vouchers.map((v) => [v.voucher_no, v.entry_date, v.vch_type, v.ref_no]),
    [
      [1, "2026-08-02", "Sales", "301"],
      [2, "2026-08-05", "Receipt", "R-9"],
      [3, "2026-08-06", "Payment", "P-4"],
      [4, "2026-08-09", "Journal", "J-2"],
    ]
  );
  assert.equal(vouchers.every((v) => v.problem === ""), true);
  // Negative = debit. 11800.00 must land as exactly 1180000 paise — the float
  // path (11800.00 * 100) is what rupeeStringToPaise exists to avoid.
  assert.deepEqual(vouchers[0].entries, [
    { ledger_name: "Sharma Traders", amount_paise: -1_180_000 },
    { ledger_name: "Sales Account", amount_paise: 1_000_000 },
    { ledger_name: "Output CGST", amount_paise: 90_000 },
    { ledger_name: "Output SGST", amount_paise: 90_000 },
  ]);
  assert.equal(vouchers[0].narration, "Cloth bill #301");
});

test("parseDayBook: file-level failures throw, voucher-level ones ride along", () => {
  assert.throws(() => parseDayBook("<ENVELOPE></ENVELOPE>"), /No <VOUCHER>/);
  const bad = parseDayBook(`<ENVELOPE><VOUCHER>
      <DATE>2026-13-45</DATE><VOUCHERTYPENAME>Sales</VOUCHERTYPENAME>
      <ALLLEDGERENTRIES.LIST><LEDGERNAME>X</LEDGERNAME><AMOUNT>oops</AMOUNT></ALLLEDGERENTRIES.LIST>
    </VOUCHER></ENVELOPE>`);
  assert.equal(bad.length, 1);
  assert.match(bad[0].problem, /not a real date/);
  assert.match(bad[0].problem, /unreadable amount "oops"/);
});

test("parseDayBook: a voucher whose ledgers don't balance is not trusted", () => {
  const [v] = parseDayBook(`<ENVELOPE><VOUCHER>
      <DATE>20260802</DATE><VOUCHERTYPENAME>Sales</VOUCHERTYPENAME>
      <ALLLEDGERENTRIES.LIST><LEDGERNAME>A</LEDGERNAME><AMOUNT>-100.00</AMOUNT></ALLLEDGERENTRIES.LIST>
      <ALLLEDGERENTRIES.LIST><LEDGERNAME>B</LEDGERNAME><AMOUNT>90.00</AMOUNT></ALLLEDGERENTRIES.LIST>
    </VOUCHER></ENVELOPE>`);
  assert.match(v.problem, /don't balance/);
});

// ---------------------------------------------------------------------------
// Ledger mapping
// ---------------------------------------------------------------------------

test("unmappedLedgers: asks once, only about importable vouchers", () => {
  const vouchers = parseDayBook(DAY_BOOK);
  // The journal's ledgers (Rent, Outstanding Rent, …) are never asked about —
  // that voucher can't be imported, so mapping them would be busywork.
  assert.deepEqual(unmappedLedgers(vouchers, []), [
    "Bank of Baroda",
    "Cash",
    "Gupta Suppliers",
    "Output CGST",
    "Output SGST",
    "Sales Account",
    "Sharma Traders",
  ]);
  // Once saved, a second Day Book from the same company asks nothing.
  assert.deepEqual(unmappedLedgers(vouchers, MAPPINGS), []);
});

test("suggestTarget: exact unique match only — an ambiguous name suggests nothing", () => {
  const parties = [{ id: 7, name: "Sharma Traders" }];
  const accounts = [
    { id: 9, name: "Cash" },
    { id: 10, name: "Sales" },
  ];
  assert.deepEqual(suggestTarget("sharma traders", parties, accounts), {
    target_kind: "party",
    id: 7,
  });
  assert.deepEqual(suggestTarget("Cash", parties, accounts), {
    target_kind: "account",
    id: 9,
  });
  assert.equal(suggestTarget("Nobody", parties, accounts), null);
  // Same name as both a party and an account: never guess (EVOLUTION #12).
  assert.equal(
    suggestTarget("Cash", [{ id: 7, name: "Cash" }], accounts),
    null
  );
});

// ---------------------------------------------------------------------------
// tallyVouchersToRows — voucher → staged row
// ---------------------------------------------------------------------------

test("mapped vouchers: type, side, party, settle account and inferred GST", () => {
  const { rows, included, excluded } = convert();
  assert.equal(included, 3);
  assert.equal(excluded, 1);
  assert.deepEqual(
    rows.slice(0, 3).map((r) => ({
      t: r.entry_type,
      dr: r.debit_paise,
      cr: r.credit_paise,
      p: r.party_id,
      gst: r.gst_rate,
      via: r.settle_account,
    })),
    [
      // Gross 11800 with 1800 of CGST+SGST reconciles to exactly 18%.
      { t: "sale", dr: 1_180_000, cr: null, p: SHARMA, gst: 18, via: "cash" },
      { t: "receipt", dr: null, cr: 500_000, p: SHARMA, gst: 0, via: "bank" },
      { t: "payment", dr: 236_000, cr: null, p: GUPTA, gst: 0, via: "cash" },
    ]
  );
  assert.equal(rows[0].particulars, "Cloth bill #301"); // no ⚠ suffix when clean
  assert.equal(rows[0].confidence, 1);
});

test("a voucher with no GST ledgers stages rate 0, never null", () => {
  // null would make buildLegs fall back to settings.default_gst_rate (18%)
  // and invent tax on a bill that never had any.
  const xml = DAY_BOOK.replace(
    /<ALLLEDGERENTRIES.LIST><LEDGERNAME>Output [CS]GST<\/LEDGERNAME>[\s\S]*?<\/ALLLEDGERENTRIES.LIST>/g,
    ""
  ).replace("<AMOUNT>10000.00</AMOUNT>", "<AMOUNT>11800.00</AMOUNT>");
  const { rows } = convert(xml);
  assert.equal(rows[0].entry_type, "sale");
  assert.equal(rows[0].gst_rate, 0);
  assert.equal(rows[0].include, true);
});

test("complex journal: excluded with a post-manually reason, amount still shown", () => {
  const { rows } = convert();
  const journal = rows[3];
  assert.equal(journal.include, false);
  assert.equal(journal.entry_type, "other"); // inside the frozen CHECK
  assert.match(journal.reason, /voucher type "Journal"/);
  assert.match(journal.reason, /post it manually via Vouchers/);
  assert.match(journal.particulars, /⚠.*post it manually/);
  assert.equal(journal.confidence, 0.2);
  assert.equal(journal.party_id, null);
  assert.equal(journal.debit_paise, 400_000); // the size of the entry, for review
});

test("a sale whose party ledger is credited would post backwards — excluded", () => {
  const flipped = DAY_BOOK.replace(
    "<LEDGERNAME>Sharma Traders</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-11800.00</AMOUNT>",
    "<LEDGERNAME>Sharma Traders</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>11800.00</AMOUNT>"
  ).replace("<AMOUNT>10000.00</AMOUNT>", "<AMOUNT>-10000.00</AMOUNT>")
    .replace("<LEDGERNAME>Output CGST</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>900.00</AMOUNT>",
      "<LEDGERNAME>Output CGST</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-900.00</AMOUNT>")
    .replace("<LEDGERNAME>Output SGST</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>900.00</AMOUNT>",
      "<LEDGERNAME>Output SGST</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-900.00</AMOUNT>");
  const { rows } = convert(flipped);
  assert.equal(rows[0].include, false);
  assert.match(rows[0].reason, /posts backwards/);
});

test("no party ledger (cash sale) and two party ledgers are both refused", () => {
  const cashSale = `<ENVELOPE><VOUCHER>
      <DATE>20260802</DATE><VOUCHERTYPENAME>Sales</VOUCHERTYPENAME><NARRATION>Counter sale</NARRATION>
      <ALLLEDGERENTRIES.LIST><LEDGERNAME>Cash</LEDGERNAME><AMOUNT>-1180.00</AMOUNT></ALLLEDGERENTRIES.LIST>
      <ALLLEDGERENTRIES.LIST><LEDGERNAME>Sales Account</LEDGERNAME><AMOUNT>1180.00</AMOUNT></ALLLEDGERENTRIES.LIST>
    </VOUCHER></ENVELOPE>`;
  const one = convert(cashSale).rows[0];
  assert.equal(one.include, false);
  assert.match(one.reason, /no party ledger/);

  const twoParties = `<ENVELOPE><VOUCHER>
      <DATE>20260802</DATE><VOUCHERTYPENAME>Receipt</VOUCHERTYPENAME>
      <ALLLEDGERENTRIES.LIST><LEDGERNAME>Sharma Traders</LEDGERNAME><AMOUNT>-500.00</AMOUNT></ALLLEDGERENTRIES.LIST>
      <ALLLEDGERENTRIES.LIST><LEDGERNAME>Gupta Suppliers</LEDGERNAME><AMOUNT>500.00</AMOUNT></ALLLEDGERENTRIES.LIST>
    </VOUCHER></ENVELOPE>`;
  const two = convert(twoParties).rows[0];
  assert.equal(two.include, false);
  assert.match(two.reason, /2 party ledgers/);
});

test("GST that reconciles to no standard rate is excluded, not rounded into one", () => {
  const odd = DAY_BOOK.replace("<AMOUNT>900.00</AMOUNT>", "<AMOUNT>800.00</AMOUNT>").replace(
    "<AMOUNT>10000.00</AMOUNT>",
    "<AMOUNT>10100.00</AMOUNT>"
  );
  const { rows } = convert(odd);
  assert.equal(rows[0].include, false);
  assert.match(rows[0].reason, /doesn't match a standard rate/);
  assert.equal(rows[0].gst_rate, null);
});

test("tax-exclusive books stage the taxable amount, not Tally's gross", () => {
  // buildLegs adds tax ON TOP when tax_inclusive = 0, so staging the gross
  // there would bill the customer 18% twice.
  const { rows } = convert(DAY_BOOK, MAPPINGS, { taxInclusive: false });
  assert.equal(rows[0].gst_rate, 18);
  assert.equal(rows[0].debit_paise, 1_000_000); // taxable, not 1_180_000
  assert.equal(rows[1].credit_paise, 500_000); // settlements are unaffected
});

/** Mappings plus the odd-ledger targets the extra-leg guards need. */
const EXTRA_MAPPINGS: LedgerMapping[] = [
  ...MAPPINGS,
  { ledger_name: "Discount Allowed", target_kind: "account", account_id: 106, party_id: null },
  { ledger_name: "TDS Receivable", target_kind: "account", account_id: 107, party_id: null },
  { ledger_name: "Suspense", target_kind: "account", account_id: 106, party_id: null },
  { ledger_name: "Sales - Yarn", target_kind: "account", account_id: 101, party_id: null },
];

test("a settlement with no cash/bank ledger is refused, never defaulted to cash", () => {
  // Defaulting would make buildLegs move money through Cash that never moved.
  const xml = `<ENVELOPE><VOUCHER>
      <DATE>20260805</DATE><VOUCHERTYPENAME>Receipt</VOUCHERTYPENAME><NARRATION>Odd receipt</NARRATION>
      <ALLLEDGERENTRIES.LIST><LEDGERNAME>Suspense</LEDGERNAME><AMOUNT>-5000.00</AMOUNT></ALLLEDGERENTRIES.LIST>
      <ALLLEDGERENTRIES.LIST><LEDGERNAME>Sharma Traders</LEDGERNAME><AMOUNT>5000.00</AMOUNT></ALLLEDGERENTRIES.LIST>
    </VOUCHER></ENVELOPE>`;
  const row = convert(xml, EXTRA_MAPPINGS).rows[0];
  assert.equal(row.include, false);
  assert.match(row.reason, /no cash or bank ledger/);
});

test("TDS withheld on a receipt: the extra leg excludes it instead of overstating the bank", () => {
  // Party leg is the GROSS 10,000 but only 9,000 reached the bank. Posting the
  // gross would debit Bank 10,000 and never book the 1,000 of TDS.
  const xml = `<ENVELOPE><VOUCHER>
      <DATE>20260805</DATE><VOUCHERTYPENAME>Receipt</VOUCHERTYPENAME><NARRATION>Receipt net of TDS</NARRATION>
      <ALLLEDGERENTRIES.LIST><LEDGERNAME>Bank of Baroda</LEDGERNAME><AMOUNT>-9000.00</AMOUNT></ALLLEDGERENTRIES.LIST>
      <ALLLEDGERENTRIES.LIST><LEDGERNAME>TDS Receivable</LEDGERNAME><AMOUNT>-1000.00</AMOUNT></ALLLEDGERENTRIES.LIST>
      <ALLLEDGERENTRIES.LIST><LEDGERNAME>Sharma Traders</LEDGERNAME><AMOUNT>10000.00</AMOUNT></ALLLEDGERENTRIES.LIST>
    </VOUCHER></ENVELOPE>`;
  const row = convert(xml, EXTRA_MAPPINGS).rows[0];
  assert.equal(row.include, false);
  assert.match(row.reason, /1 extra ledger beyond the settlement/);
});

test("a non-revenue leg on a sale (discount, round-off) excludes it", () => {
  // Zero-tax so the GST reconciliation can't be the thing that catches it.
  const xml = `<ENVELOPE><VOUCHER>
      <DATE>20260802</DATE><VOUCHERTYPENAME>Sales</VOUCHERTYPENAME><NARRATION>Sale less discount</NARRATION>
      <ALLLEDGERENTRIES.LIST><LEDGERNAME>Sharma Traders</LEDGERNAME><AMOUNT>-9700.00</AMOUNT></ALLLEDGERENTRIES.LIST>
      <ALLLEDGERENTRIES.LIST><LEDGERNAME>Sales Account</LEDGERNAME><AMOUNT>10000.00</AMOUNT></ALLLEDGERENTRIES.LIST>
      <ALLLEDGERENTRIES.LIST><LEDGERNAME>Discount Allowed</LEDGERNAME><AMOUNT>-300.00</AMOUNT></ALLLEDGERENTRIES.LIST>
    </VOUCHER></ENVELOPE>`;
  const row = convert(xml, EXTRA_MAPPINGS).rows[0];
  assert.equal(row.include, false);
  assert.match(row.reason, /1 extra ledger beyond income and tax/);
});

test("a fixed asset bought on a Purchase voucher is refused, not expensed", () => {
  const xml = `<ENVELOPE><VOUCHER>
      <DATE>20260802</DATE><VOUCHERTYPENAME>Purchase</VOUCHERTYPENAME><NARRATION>New laptop</NARRATION>
      <ALLLEDGERENTRIES.LIST><LEDGERNAME>TDS Receivable</LEDGERNAME><AMOUNT>-50000.00</AMOUNT></ALLLEDGERENTRIES.LIST>
      <ALLLEDGERENTRIES.LIST><LEDGERNAME>Sharma Traders</LEDGERNAME><AMOUNT>50000.00</AMOUNT></ALLLEDGERENTRIES.LIST>
    </VOUCHER></ENVELOPE>`;
  const row = convert(xml, EXTRA_MAPPINGS).rows[0];
  assert.equal(row.include, false);
  assert.match(row.reason, /no expense ledger/);
});

test("two revenue ledgers on one sale still import — buildLegs sums them into Sales", () => {
  const xml = `<ENVELOPE><VOUCHER>
      <DATE>20260802</DATE><VOUCHERTYPENAME>Sales</VOUCHERTYPENAME><NARRATION>Cloth and yarn</NARRATION>
      <ALLLEDGERENTRIES.LIST><LEDGERNAME>Sharma Traders</LEDGERNAME><AMOUNT>-11800.00</AMOUNT></ALLLEDGERENTRIES.LIST>
      <ALLLEDGERENTRIES.LIST><LEDGERNAME>Sales Account</LEDGERNAME><AMOUNT>6000.00</AMOUNT></ALLLEDGERENTRIES.LIST>
      <ALLLEDGERENTRIES.LIST><LEDGERNAME>Sales - Yarn</LEDGERNAME><AMOUNT>4000.00</AMOUNT></ALLLEDGERENTRIES.LIST>
      <ALLLEDGERENTRIES.LIST><LEDGERNAME>Output CGST</LEDGERNAME><AMOUNT>900.00</AMOUNT></ALLLEDGERENTRIES.LIST>
      <ALLLEDGERENTRIES.LIST><LEDGERNAME>Output SGST</LEDGERNAME><AMOUNT>900.00</AMOUNT></ALLLEDGERENTRIES.LIST>
    </VOUCHER></ENVELOPE>`;
  const row = convert(xml, EXTRA_MAPPINGS).rows[0];
  assert.equal(row.include, true);
  assert.equal(row.debit_paise, 1_180_000);
  assert.equal(row.gst_rate, 18);
});

test("a broken mapping row is reported, never dropped silently", () => {
  // A dropped leg could make a two-party voucher look like a clean one-party one.
  const broken: LedgerMapping[] = [
    ...MAPPINGS.filter((m) => m.ledger_name !== "Sales Account"),
    { ledger_name: "Sales Account", target_kind: "account", account_id: null, party_id: null },
  ];
  const row = convert(DAY_BOOK, broken).rows[0];
  assert.equal(row.include, false);
  assert.match(row.reason, /"Sales Account" has a broken mapping/);
});

test("an unmapped ledger excludes its voucher rather than guessing", () => {
  const partial = MAPPINGS.filter((m) => m.ledger_name !== "Output CGST");
  const { rows } = convert(DAY_BOOK, partial);
  assert.equal(rows[0].include, false);
  assert.match(rows[0].reason, /ledger "Output CGST" is not mapped/);
});

// ---------------------------------------------------------------------------
// Against a db from the ORIGINAL DDL — the frozen staged_rows CHECK must
// accept everything the Tally path emits, and the rows must post cleanly.
// ---------------------------------------------------------------------------

function tallyDb(): Database.Database {
  const db = new Database(":memory:");
  initSchema(db);
  seedCoreData(db);
  db.prepare(
    `INSERT INTO parties (name, kind, gstin, state_code, phone, created_at)
     VALUES ('Sharma Traders', 'customer', '', '27', '', '2026-08-01T00:00:00Z'),
            ('Gupta Suppliers', 'supplier', '', '27', '', '2026-08-01T00:00:00Z')`
  ).run();
  return db;
}

test("ledger_mappings: name is unique and exactly one target is set", () => {
  const db = tallyDb();
  const insert = db.prepare(
    `INSERT INTO ledger_mappings (ledger_name, target_kind, account_id, party_id, created_at)
     VALUES (@ledger_name, @target_kind, @account_id, @party_id, '2026-08-01T00:00:00Z')`
  );
  insert.run({ ledger_name: "Cash", target_kind: "account", account_id: 1, party_id: null });
  assert.throws(
    () => insert.run({ ledger_name: "Cash", target_kind: "account", account_id: 2, party_id: null }),
    /UNIQUE/
  );
  // A party mapping carrying an account id (or neither) must not be storable.
  assert.throws(
    () => insert.run({ ledger_name: "X", target_kind: "party", account_id: 1, party_id: null }),
    /CHECK/
  );
  assert.throws(
    () => insert.run({ ledger_name: "Y", target_kind: "account", account_id: null, party_id: 1 }),
    /CHECK/
  );
});

test("end-to-end: parse → map → stage (frozen CHECK holds) → post → TB zero", () => {
  const db = tallyDb();
  const parsed = convert();
  assert.equal(parsed.included, 3);

  db.prepare(
    `INSERT INTO documents (party_id, image_path, image_sha256, status, source_type, model, created_at, extracted_at)
     VALUES (1, 'data/uploads/daybook.xml', 'tally-sha', 'extracted', 'tally', 'tally-daybook', '2026-08-10T00:00:00Z', '2026-08-10T00:00:00Z')`
  ).run();
  const insert = db.prepare(
    `INSERT INTO staged_rows
       (document_id, row_no, entry_date, particulars, ref_no, debit_paise, credit_paise,
        entry_type, gst_rate, settle_account, confidence, is_balance_row, include, party_id)
     VALUES (1, @row_no, @entry_date, @particulars, @ref_no, @debit_paise, @credit_paise,
             @entry_type, @gst_rate, @settle_account, @confidence, 0, @include, @party_id)`
  );
  // Every row inserts — including the journal mapped to 'other' — proving
  // nothing the Tally path emits violates the frozen 8-value CHECK.
  for (const r of parsed.rows) {
    insert.run({
      row_no: r.row_no,
      entry_date: r.entry_date,
      particulars: r.particulars,
      ref_no: r.ref_no,
      debit_paise: r.debit_paise,
      credit_paise: r.credit_paise,
      entry_type: r.entry_type,
      gst_rate: r.gst_rate,
      settle_account: r.settle_account,
      confidence: r.confidence,
      include: r.include ? 1 : 0,
      party_id: r.party_id,
    });
  }

  const staged = db
    .prepare("SELECT * FROM staged_rows WHERE document_id = 1 ORDER BY row_no")
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
    settle_account: r.settle_account,
    include: r.include === 1,
  }));
  const { journals } = postDocument(db, 1, drafts);
  assert.equal(journals, 3);

  const sum = db
    .prepare("SELECT SUM(debit_paise) - SUM(credit_paise) AS d FROM journal_lines")
    .get() as { d: number };
  assert.equal(sum.d, 0);

  const bal = (code: string, partyId: number | null) =>
    (
      db
        .prepare(
          `SELECT COALESCE(SUM(jl.debit_paise) - SUM(jl.credit_paise), 0) AS b
           FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
           WHERE a.code = ? AND jl.party_id IS ?`
        )
        .get(code, partyId) as { b: number }
    ).b;
  // Sale 11800 less the 5000 receipt.
  assert.equal(bal("1200", SHARMA), 680_000);
  assert.equal(bal("2100", GUPTA), 236_000); // payment debited the supplier
  assert.equal(bal("4000", null), -1_000_000); // taxable income, credit-heavy
  assert.equal(bal("2200", null), -90_000); // CGST
  assert.equal(bal("2210", null), -90_000); // SGST
  assert.equal(bal("1100", null), 500_000); // receipt landed in bank
  assert.equal(bal("1000", null), -236_000); // payment left cash
});
