import { strict as assert } from "node:assert";
import { test } from "node:test";
import type Database from "better-sqlite3";
import { buildComputation } from "../src/lib/tax/computation";
import { postManualVoucher } from "../src/lib/vouchers";
import { postedDb } from "./helpers";

const FY = "2026-27";
const R = (rupees: number) => rupees * 100;
/** The demo books' FY profit: ₹11,000. */
const BOOK_PROFIT = R(11_000);

function addAsset(db: Database.Database, costPaise: number): void {
  db.prepare(
    `INSERT INTO fixed_assets (name, block, cost_paise, purchase_date, put_to_use_date, created_at)
     VALUES ('Laptop', 'computers', ?, '2026-04-01', '2026-04-01', 'now')`
  ).run(costPaise);
}

function addAdjustment(
  db: Database.Database,
  kind: "addback" | "deduction",
  amountPaise: number
): void {
  db.prepare(
    `INSERT INTO it_adjustments (fy, kind, section, description, amount_paise, created_at)
     VALUES (?, ?, '', ?, ?, 'now')`
  ).run(FY, kind, `${kind} line`, amountPaise);
}

test("book path: with nothing to adjust, total income is the book profit", () => {
  const db = postedDb();
  const c = buildComputation(db, FY);
  assert.equal(c.book_profit_paise, BOOK_PROFIT);
  assert.equal(c.book_depreciation_paise, 0);
  assert.equal(c.it_depreciation_paise, 0);
  assert.equal(c.gross_total_income_paise, BOOK_PROFIT);
  assert.equal(c.taxable_income_paise, BOOK_PROFIT);
  // Far below the first slab, so nil — and via the rebate, not by accident.
  assert.equal(c.tax.total_tax_paise, 0);
  assert.equal(c.net_payable_paise, 0);
});

test("the depreciation bridge: book charge comes back out, the Act's goes in", () => {
  const db = postedDb();
  addAsset(db, R(100_000)); // computers, full year → 40% = ₹40,000
  // The books charged a different figure — the two must not be conflated.
  postManualVoucher(db, {
    kind: "journal",
    entry_type: "depreciation",
    entry_date: "2027-03-31",
    memo: "Book depreciation",
    ref_no: "DEP",
    legs: [
      { account_code: "5800", party_id: null, debit_paise: R(30_000), credit_paise: 0 },
      { account_code: "1590", party_id: null, debit_paise: 0, credit_paise: R(30_000) },
    ],
  });

  const c = buildComputation(db, FY);
  assert.equal(c.book_depreciation_paise, R(30_000));
  assert.equal(c.it_depreciation_paise, R(40_000));
  // Book profit is already net of the ₹30,000 charge.
  assert.equal(c.book_profit_paise, BOOK_PROFIT - R(30_000));
  // …added back, then the Act's ₹40,000 deducted instead.
  assert.equal(c.gross_total_income_paise, BOOK_PROFIT - R(40_000));
  // A loss floors the taxable figure at zero rather than going negative.
  assert.equal(c.taxable_income_paise, 0);
  assert.equal(c.tax.total_tax_paise, 0);

  const labels = c.lines.map((l) => l.label);
  assert.ok(labels.some((l) => /Add: depreciation charged in the books/.test(l)));
  assert.ok(labels.some((l) => /Less: depreciation as per the Income-tax Act/.test(l)));
});

test("adjustments move total income in the direction they claim", () => {
  const db = postedDb();
  addAdjustment(db, "addback", R(50_000));
  addAdjustment(db, "deduction", R(20_000));
  const c = buildComputation(db, FY);
  assert.equal(c.addbacks_paise, R(50_000));
  assert.equal(c.deductions_paise, R(20_000));
  assert.equal(
    c.gross_total_income_paise,
    BOOK_PROFIT + R(50_000) - R(20_000)
  );
});

test("a presumptive scheme replaces the book path entirely", () => {
  const db = postedDb();
  addAsset(db, R(100_000)); // would otherwise deduct ₹40,000
  addAdjustment(db, "addback", R(50_000)); // and this would otherwise add
  db.prepare("UPDATE settings SET presumptive = '44AD' WHERE id = 1").run();

  const c = buildComputation(db, FY);
  // Turnover is ₹16,000 of sales in the demo books; 8% of it, no digital split.
  assert.equal(c.turnover_paise, R(16_000));
  assert.equal(c.gross_total_income_paise, R(1_280));
  // Neither depreciation nor the adjustment reaches the total.
  assert.ok(!c.lines.some((l) => /depreciation/i.test(l.label)));
  assert.ok(!c.lines.some((l) => /addback line/.test(l.label)));
  assert.ok(c.lines.some((l) => /Presumptive income under 44AD/.test(l.label)));
});

test("taxes paid net off the liability, and an overpayment reads as a refund", () => {
  const db = postedDb();
  // Push income into a taxable band so there is something to net against.
  addAdjustment(db, "addback", R(15_00_000));
  const before = buildComputation(db, FY);
  assert.ok(before.tax.total_tax_paise > 0, "should be taxable");

  db.prepare(
    `INSERT INTO tax_payments (fy, kind, paid_on, amount_paise, note, created_at)
     VALUES (?, 'advance', '2026-06-15', ?, '', 'now')`
  ).run(FY, before.tax.total_tax_paise + R(5_000));

  const after = buildComputation(db, FY);
  assert.equal(after.payments_paise, before.tax.total_tax_paise + R(5_000));
  assert.equal(after.net_payable_paise, -R(5_000)); // negative = refund
});

test("the computation carries the rate caveat for an unconfirmed year", () => {
  const db = postedDb();
  const c = buildComputation(db, FY);
  // These books sit in a year with no confirmed table, so every consumer of
  // this object has to be told before the numbers are used.
  assert.equal(c.provisional, true);
  assert.ok(c.caveat.length > 0);
  assert.match(c.caveat, /Confirm this year's rates before filing/);
});

test("total income is rounded to the nearest ten rupees before tax is applied", () => {
  const db = postedDb();
  addAdjustment(db, "addback", R(1_234) + 56); // ₹1,234.56
  const c = buildComputation(db, FY);
  assert.equal(c.gross_total_income_paise, BOOK_PROFIT + R(1_234) + 56);
  assert.equal(c.taxable_income_paise % R(10), 0, "rounded to a ₹10 multiple");
  assert.equal(c.taxable_income_paise, R(12_230));
});

test("a firm gets its partner-remuneration ceiling as guidance, not a silent cap", () => {
  const db = postedDb();
  assert.equal(
    buildComputation(db, FY).partner_remuneration_ceiling_paise,
    null,
    "not a firm — no ceiling"
  );

  db.prepare("UPDATE settings SET entity_type = 'partnership' WHERE id = 1").run();
  addAdjustment(db, "deduction", R(50_00_000)); // an absurd remuneration claim
  const c = buildComputation(db, FY);
  // Book profit ₹11,000 → the floor applies.
  assert.equal(c.partner_remuneration_ceiling_paise, R(300_000));
  assert.equal(c.book_profit_paise, BOOK_PROFIT);
  // Crucially the deduction is NOT quietly capped — the office sees the
  // ceiling and decides, rather than the number changing under them.
  assert.equal(c.deductions_paise, R(50_00_000));
  assert.equal(c.gross_total_income_paise, BOOK_PROFIT - R(50_00_000));
});

test("the remuneration ceiling is measured on book profit, NOT with depreciation added back", () => {
  // The add-back belongs to the taxable-income bridge, not to the book-profit
  // figure this ceiling sits on. Adding it here overstates the ceiling by the
  // whole depreciation charge — and only shows up when that charge is non-zero,
  // which is why the first version of this test missed it.
  const db = postedDb();
  db.prepare("UPDATE settings SET entity_type = 'partnership' WHERE id = 1").run();
  postManualVoucher(db, {
    kind: "journal",
    entry_type: "depreciation",
    entry_date: "2027-03-31",
    memo: "Book depreciation",
    ref_no: "DEP",
    legs: [
      { account_code: "5800", party_id: null, debit_paise: R(9_50_000), credit_paise: 0 },
      { account_code: "1590", party_id: null, debit_paise: 0, credit_paise: R(9_50_000) },
    ],
  });

  const c = buildComputation(db, FY);
  assert.equal(c.book_depreciation_paise, R(9_50_000));
  // A large book charge pushes the P&L into a loss, so the ceiling is the floor.
  assert.equal(c.book_profit_paise, BOOK_PROFIT - R(9_50_000));
  assert.equal(c.partner_remuneration_ceiling_paise, R(300_000));
  // The wrong basis (profit + depreciation) would have produced ₹7,86,600.
  assert.notEqual(c.partner_remuneration_ceiling_paise, R(786_600));
});

test("entity type drives which rate structure is used", () => {
  const db = postedDb();
  addAdjustment(db, "addback", R(20_00_000)); // ₹20L of income
  const individual = buildComputation(db, FY);
  assert.match(individual.tax.basis, /Individual/);

  db.prepare("UPDATE settings SET entity_type = 'partnership' WHERE id = 1").run();
  const firm = buildComputation(db, FY);
  assert.match(firm.tax.basis, /Firm/);
  // A firm pays a flat rate from the first rupee, so it owes more than an
  // individual on the same income, whose first ₹4L is exempt.
  assert.ok(firm.tax.total_tax_paise > individual.tax.total_tax_paise);

  db.prepare("UPDATE settings SET entity_type = 'company' WHERE id = 1").run();
  assert.match(buildComputation(db, FY).tax.basis, /company/);
});
