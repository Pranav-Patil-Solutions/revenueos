import { strict as assert } from "node:assert";
import { test } from "node:test";
import Database from "better-sqlite3";
import { initSchema, seedCoreData } from "../src/lib/db";
import { migrate } from "../src/lib/migrate";
import { MIGRATIONS } from "../src/lib/migrations";
import {
  dashboardStats,
  dayBook,
  documentStatusBreakdown,
  gstr1B2B,
  gstr3b,
  partyStatement,
  profitAndLoss,
  receivablesTrend,
  trialBalance,
} from "../src/lib/reports";
import { book } from "../src/lib/book";
import { postedDb } from "./helpers";

/** Fresh, empty (unposted) books — schema + chart of accounts only. Lets
 * gap tests post exactly the AR-control legs they need without the demo
 * fixture's other entries in the way. */
function emptyDb(): Database.Database {
  const db = new Database(":memory:");
  initSchema(db);
  seedCoreData(db);
  migrate(db, MIGRATIONS, { now: "2026-01-01T00:00:00.000Z" });
  return db;
}

function arAccountId(db: Database.Database): number {
  return (
    db.prepare("SELECT id FROM accounts WHERE code = '1200'").get() as {
      id: number;
    }
  ).id;
}

/** Post a single balanced journal moving `paise` between AR (1200) and cash
 * (1000), on the AR side per `dir` — 'debit' grows AR, 'credit' shrinks it
 * (or, if it overshoots, flips it to a net credit / customer-advance
 * balance). */
function postAr(
  db: Database.Database,
  date: string,
  dir: "debit" | "credit",
  paise: number
): void {
  const ar = arAccountId(db);
  const cash = (
    db.prepare("SELECT id FROM accounts WHERE code = '1000'").get() as {
      id: number;
    }
  ).id;
  const journalId = db
    .prepare(
      `INSERT INTO journals (entry_date, entry_type, memo, ref_no, created_at)
       VALUES (?, 'journal', '', '', ?)`
    )
    .run(date, `${date}T00:00:00Z`).lastInsertRowid as number;
  const insertLine = db.prepare(
    `INSERT INTO journal_lines (journal_id, line_no, account_id, debit_paise, credit_paise)
     VALUES (?, ?, ?, ?, ?)`
  );
  if (dir === "debit") {
    insertLine.run(journalId, 1, ar, paise, 0);
    insertLine.run(journalId, 2, cash, 0, paise);
  } else {
    insertLine.run(journalId, 1, cash, paise, 0);
    insertLine.run(journalId, 2, ar, 0, paise);
  }
}

const MONTH = "2026-07";

test("trial balance: balanced, with the expected account balances", () => {
  const db = book(postedDb(), 1);
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
  const db = book(postedDb(), 1);
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
  const db = book(postedDb(), 1);
  const g = gstr3b(db, MONTH);
  assert.equal(g.outward_taxable_paise, 1_600_000); // ₹16,000.00
  assert.equal(g.cgst_paise, 129_000); // ₹1,290.00
  assert.equal(g.sgst_paise, 129_000); // ₹1,290.00
  assert.equal(g.igst_paise, 0);
  assert.equal(g.itc_paise, 90_000); // ₹900.00
  assert.equal(g.net_payable_paise, 168_000); // ₹1,680.00
});

test("GSTR-3B: an empty month is all zeros", () => {
  const g = gstr3b(book(postedDb(), 1), "2026-08");
  assert.equal(g.outward_taxable_paise, 0);
  assert.equal(g.net_payable_paise, 0);
});

test("GSTR-1 B2B: 3 invoices + 1 credit note, tax splits per document", () => {
  const db = book(postedDb(), 1);
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
  const db = book(postedDb(), 1);
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

test("party statement asOf slices BOTH ledgers, inclusively", () => {
  const db = book(postedDb(), 1);
  const early = partyStatement(db, 1, "2026-07-05")!;
  assert.equal(early.lines.length, 3); // opening, sale #241, the 5 Jul receipt
  assert.equal(early.closing_paise, 980_000); // 5,000 + 11,800 − 7,000
  assert.equal(early.cross_ledger_paise, 0); // the purchase only lands 14 Jul
  // Cross ledger is dated too: purchase (14 Jul) in, payment (15 Jul) not yet.
  const mid = partyStatement(db, 1, "2026-07-14")!;
  assert.equal(mid.closing_paise, 1_258_000);
  assert.equal(mid.cross_ledger_paise, 590_000);
  assert.equal(mid.net_position_paise, 668_000);
  const before = partyStatement(db, 1, "2026-06-30")!;
  assert.equal(before.lines.length, 0);
  assert.equal(before.closing_paise, 0);
  assert.equal(before.cross_ledger_paise, 0);
  // Omitting asOf stays byte-identical to full history.
  assert.deepEqual(partyStatement(db, 1, "2099-12-31"), partyStatement(db, 1));
});

test("day book: 9 journals in date order, each internally balanced", () => {
  const db = book(postedDb(), 1);
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
  const db = book(postedDb(), 1);
  const s = dashboardStats(db, MONTH);
  assert.equal(s.receivables_paise, 1_258_000);
  assert.equal(s.gst_payable_paise, 168_000);
  assert.equal(s.pending_review, 0); // the demo doc is posted
  assert.equal(s.journals_this_month, 9);
});

test("receivables trend: the final point IS the AR control total", () => {
  const db = book(postedDb(), 1);
  const trend = receivablesTrend(db, MONTH, 4);
  assert.equal(trend.length, 4);
  assert.equal(trend[trend.length - 1].month, MONTH);
  // The property that matters: the series is the SAME balance the dashboard
  // tile reports, sampled at month ends — not a parallel computation that can
  // drift from it. All demo entries fall in 2026-07, so the window's last
  // point must equal the all-time control total exactly.
  assert.equal(
    trend[trend.length - 1].closing_paise,
    dashboardStats(db, MONTH).receivables_paise
  );
  assert.equal(trend[trend.length - 1].closing_paise, 1_258_000);
});

test("receivables trend: months before any entry read zero, and it is a BALANCE", () => {
  const db = book(postedDb(), 1);
  const trend = receivablesTrend(db, MONTH, 4);
  assert.deepEqual(
    trend.map((p) => p.month),
    ["2026-04", "2026-05", "2026-06", "2026-07"]
  );
  // Nothing posted before July, so every earlier close is flat zero.
  for (const p of trend.slice(0, 3)) assert.equal(p.closing_paise, 0);
  // A balance carries forward: asking for a window that STARTS after the
  // entries must still report them, via the opening balance.
  const later = receivablesTrend(db, "2026-10", 2);
  assert.deepEqual(
    later.map((p) => p.closing_paise),
    [1_258_000, 1_258_000]
  );
});

test("receivables trend: the window steps across a year boundary", () => {
  const db = book(postedDb(), 1);
  const trend = receivablesTrend(db, "2027-01", 4);
  assert.deepEqual(
    trend.map((p) => p.month),
    ["2026-10", "2026-11", "2026-12", "2027-01"]
  );
});

test("document status: counted, pipeline-ordered, zeroes omitted", () => {
  const rawDb = postedDb();
  const db = book(rawDb, 1);
  const slices = documentStatusBreakdown(db);
  // One document, posted by postedDb — so exactly one slice, no empty ones.
  assert.deepEqual(slices, [{ status: "posted", count: 1 }]);

  rawDb
    .prepare(
      `INSERT INTO documents (company_id, party_id, image_path, image_sha256, status, created_at)
       VALUES (1, 1, 'a.jpg', 'sha-a', 'uploaded', '2026-07-20T00:00:00Z'),
              (1, 1, 'b.jpg', 'sha-b', 'extracted', '2026-07-21T00:00:00Z'),
              (1, 1, 'c.jpg', 'sha-c', 'extracted', '2026-07-22T00:00:00Z')`
    )
    .run();
  const after = documentStatusBreakdown(db);
  // Ordered by pipeline stage (posted → extracted → uploaded), NOT by count.
  assert.deepEqual(after, [
    { status: "posted", count: 1 },
    { status: "extracted", count: 2 },
    { status: "uploaded", count: 1 },
  ]);
  const census = rawDb
    .prepare("SELECT COUNT(*) AS n FROM documents WHERE company_id = 1")
    .get() as { n: number };
  assert.equal(
    after.reduce((n, s) => n + s.count, 0),
    census.n
  );
});

test("receivables trend: a net CREDIT balance (customer advance) still reports correctly", () => {
  const rawDb = emptyDb();
  const db = book(rawDb, 1);
  // 10,000 received in advance of any sale — AR goes net credit (negative).
  postAr(rawDb, "2026-07-10", "credit", 1_000_000);
  const trend = receivablesTrend(db, "2026-07", 3);
  assert.deepEqual(
    trend.map((p) => p.month),
    ["2026-05", "2026-06", "2026-07"]
  );
  assert.equal(trend[0].closing_paise, 0); // nothing posted yet
  assert.equal(trend[1].closing_paise, 0);
  assert.equal(trend[2].closing_paise, -1_000_000); // customer advance: net credit
  // Ties to the AR control account itself — not a parallel computation.
  const control = rawDb
    .prepare(
      `SELECT COALESCE(SUM(jl.debit_paise), 0) - COALESCE(SUM(jl.credit_paise), 0) AS net
       FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
       WHERE a.code = '1200'`
    )
    .get() as { net: number };
  assert.equal(trend[2].closing_paise, control.net);

  // A partial repayment (sale) the next month pulls it back toward zero but
  // it should stay a net credit, not clamp at zero.
  postAr(rawDb, "2026-08-05", "debit", 400_000);
  const trend2 = receivablesTrend(db, "2026-08", 1);
  assert.deepEqual(trend2, [{ month: "2026-08", closing_paise: -600_000 }]);
});

test("receivablesTrend with count=1 returns exactly the one closing point", () => {
  const db = book(postedDb(), 1);
  const trend = receivablesTrend(db, MONTH, 1);
  assert.equal(trend.length, 1);
  assert.deepEqual(trend[0], { month: MONTH, closing_paise: 1_258_000 });

  // count=1 for a month with nothing posted yet is a flat zero, not an error.
  const before = receivablesTrend(db, "2026-01", 1);
  assert.deepEqual(before, [{ month: "2026-01", closing_paise: 0 }]);
});

test("receivablesTrend rejects count < 1", () => {
  const db = book(postedDb(), 1);
  assert.throws(() => receivablesTrend(db, MONTH, 0), /count >= 1/);
  assert.throws(() => receivablesTrend(db, MONTH, -1), /count >= 1/);
});

test("document status: an empty documents table returns an empty breakdown", () => {
  const rawDb = emptyDb();
  const db = book(rawDb, 1);
  const census = rawDb
    .prepare("SELECT COUNT(*) AS n FROM documents")
    .get() as { n: number };
  assert.equal(census.n, 0);
  assert.deepEqual(documentStatusBreakdown(db), []);
});
