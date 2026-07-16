import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  dashboardStats,
  dayBook,
  gstr1B2B,
  gstr3b,
  partyStatement,
  profitAndLoss,
  trialBalance,
} from "../src/lib/reports";
import { postedDb } from "./helpers";

const MONTH = "2026-07";

test("trial balance: balanced, with the expected account balances", () => {
  const db = postedDb();
  const tb = trialBalance(db);
  assert.equal(tb.balanced, true);
  assert.equal(tb.total_debit_paise, tb.total_credit_paise);

  const by = Object.fromEntries(tb.lines.map((l) => [l.code, l]));
  assert.equal(by["1200"].debit_paise, 1_258_000); // AR ₹12,580.00
  assert.equal(by["1000"].debit_paise, 500_000); // Cash 7,000 in − 2,000 out
  assert.equal(by["1100"].debit_paise, 400_000); // Bank NEFT
  assert.equal(by["1300"].debit_paise, 90_000); // ITC ₹900
  assert.equal(by["4000"].credit_paise, 1_600_000); // Sales net of credit note
  assert.equal(by["2200"].credit_paise, 129_000); // CGST ₹1,290
  assert.equal(by["2210"].credit_paise, 129_000); // SGST ₹1,290
  assert.equal(by["2100"].credit_paise, 390_000); // AP 5,900 − 2,000
  assert.equal(by["3000"].credit_paise, 500_000); // Opening equity
  assert.equal(by["5000"].debit_paise, 500_000); // Purchases taxable
});

test("P&L for the month: income ₹16,000.00, purchases ₹5,000.00", () => {
  const db = postedDb();
  const pnl = profitAndLoss(db, MONTH);
  assert.equal(pnl.total_income_paise, 1_600_000);
  assert.equal(pnl.total_expense_paise, 500_000);
  assert.equal(pnl.net_profit_paise, 1_100_000);
  const purchases = pnl.expense_lines.find((l) => l.code === "5000");
  assert.equal(purchases?.amount_paise, 500_000);
  // All-time equals the month here — one month of data.
  assert.deepEqual(profitAndLoss(db), pnl);
});

test("GSTR-3B: the exact filing-prep figures", () => {
  const db = postedDb();
  const g = gstr3b(db, MONTH);
  assert.equal(g.outward_taxable_paise, 1_600_000); // ₹16,000.00
  assert.equal(g.cgst_paise, 129_000); // ₹1,290.00
  assert.equal(g.sgst_paise, 129_000); // ₹1,290.00
  assert.equal(g.igst_paise, 0);
  assert.equal(g.itc_paise, 90_000); // ₹900.00
  assert.equal(g.net_payable_paise, 168_000); // ₹1,680.00
});

test("GSTR-3B: an empty month is all zeros", () => {
  const g = gstr3b(postedDb(), "2026-08");
  assert.equal(g.outward_taxable_paise, 0);
  assert.equal(g.net_payable_paise, 0);
});

test("GSTR-1 B2B: 3 invoices + 1 credit note, tax splits per document", () => {
  const db = postedDb();
  const rows = gstr1B2B(db, MONTH);
  assert.equal(rows.length, 4);
  assert.equal(rows.filter((r) => r.doc_type === "Invoice").length, 3);
  assert.equal(rows.filter((r) => r.doc_type === "Credit note").length, 1);

  const inv241 = rows.find((r) => r.ref_no === "241");
  assert.ok(inv241);
  assert.equal(inv241.taxable_paise, 1_000_000);
  assert.equal(inv241.cgst_paise, 90_000);
  assert.equal(inv241.sgst_paise, 90_000);
  assert.equal(inv241.gross_paise, 1_180_000);
  assert.equal(inv241.party_name, "Sharma Traders");
  assert.equal(inv241.party_gstin, "27AAACS1234F1Z5");

  const cn = rows.find((r) => r.doc_type === "Credit note");
  assert.equal(cn?.taxable_paise, 100_000);
  const taxableNet =
    rows.reduce(
      (s, r) => s + (r.doc_type === "Invoice" ? r.taxable_paise : -r.taxable_paise),
      0
    );
  assert.equal(taxableNet, 1_600_000); // reconciles with GSTR-3B
});

test("party statement: 7 AR movements, closing ₹12,580.00, running balance", () => {
  const db = postedDb();
  const s = partyStatement(db, 1);
  assert.ok(s);
  assert.equal(s.lines.length, 7); // opening, 3 sales, 2 receipts, 1 credit note
  assert.equal(s.closing_paise, 1_258_000);
  assert.equal(s.lines[0].balance_paise, 500_000); // opening
  assert.equal(s.lines[s.lines.length - 1].balance_paise, 1_258_000);
  // Purchases/payments ride AP, not the customer statement…
  assert.ok(!s.lines.some((l) => l.entry_type === "purchase" || l.entry_type === "payment"));
  // …but they must not vanish: the cross-ledger balance carries them.
  assert.equal(s.cross_ledger_paise, 390_000); // purchase 5,900 − payment 2,000
  assert.equal(s.net_position_paise, 868_000); // 12,580 − 3,900
  assert.equal(partyStatement(db, 99), null);
});

test("day book: 9 journals in date order, each internally balanced", () => {
  const db = postedDb();
  const entries = dayBook(db, MONTH);
  assert.equal(entries.length, 9);
  const dates = entries.map((e) => e.entry_date);
  assert.deepEqual(dates, [...dates].sort());
  for (const e of entries) {
    const dr = e.legs.reduce((s, l) => s + l.debit_paise, 0);
    const cr = e.legs.reduce((s, l) => s + l.credit_paise, 0);
    assert.equal(dr, cr, `journal ${e.id}`);
  }
  assert.equal(dayBook(db).length, 9); // no filter = everything
});

test("dashboard stats", () => {
  const db = postedDb();
  const s = dashboardStats(db, MONTH);
  assert.equal(s.receivables_paise, 1_258_000);
  assert.equal(s.gst_payable_paise, 168_000);
  assert.equal(s.pending_review, 0); // the demo doc is posted
  assert.equal(s.journals_this_month, 9);
});
