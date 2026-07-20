/**
 * End-to-end smoke: fresh temp db → seed → fake upload → DEMO extract →
 * review-exclude row 10 → post → assert trial balance 0, AR ₹12,580.00, and
 * the exact GSTR-3B figures. Run: DEMO_MODE=1 npx tsx scripts/smoke.ts
 */
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.DEMO_MODE ??= "1";
if (process.env.DEMO_MODE !== "1") {
  console.error("smoke requires DEMO_MODE=1 (it must not burn subscription calls)");
  process.exit(1);
}

// A fresh working directory BEFORE importing db.ts, which anchors its data
// dir to process.cwd() at import time.
const tmp = mkdtempSync(path.join(tmpdir(), "revenueos-smoke-"));
process.chdir(tmp);

let step = "";
const ok = (msg: string) => console.log(`  ✓ ${msg}`);

async function main(): Promise<void> {
  step = "boot fresh db + seeds";
  const { getDb, SEED_ACCOUNTS } = await import("../src/lib/db");
  const db = getDb();
  const accounts = db.prepare("SELECT COUNT(*) AS n FROM accounts").get() as { n: number };
  assert.equal(accounts.n, SEED_ACCOUNTS.length, "chart of accounts");
  const ungrouped = db
    .prepare("SELECT COUNT(*) AS n FROM accounts WHERE group_code IS NULL")
    .get() as { n: number };
  assert.equal(ungrouped.n, 0, "every account grouped");
  const sharma = db
    .prepare("SELECT id FROM parties WHERE name = 'Sharma Traders'")
    .get() as { id: number } | undefined;
  assert.ok(sharma, "DEMO_MODE seeds Sharma Traders");
  ok(`fresh db at ${tmp} — ${SEED_ACCOUNTS.length} grouped accounts, demo parties seeded`);

  step = "fake upload";
  mkdirSync(path.join(tmp, "data", "uploads"), { recursive: true });
  writeFileSync(path.join(tmp, "data", "uploads", "smoke.jpg"), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  const docId = Number(
    db
      .prepare(
        `INSERT INTO documents (party_id, image_path, image_sha256, status, created_at)
         VALUES (?, 'data/uploads/smoke.jpg', 'smoke-sha', 'uploaded', ?)`
      )
      .run(sharma!.id, new Date().toISOString()).lastInsertRowid
  );
  ok(`document #${docId} uploaded`);

  step = "DEMO extraction";
  const { extractDocument } = await import("../src/lib/extraction");
  const { rows } = await extractDocument(docId);
  assert.equal(rows, 11, "fixture has 11 rows");
  const excluded = db
    .prepare("SELECT COUNT(*) AS n FROM staged_rows WHERE document_id = ? AND include = 0")
    .get(docId) as { n: number };
  assert.equal(excluded.n, 1, "balance row auto-excluded");
  ok("extracted 11 rows, balance row pre-excluded");

  step = "review + post (row 10 excluded)";
  const { postDocument } = await import("../src/lib/posting");
  const staged = db
    .prepare("SELECT * FROM staged_rows WHERE document_id = ? ORDER BY row_no")
    .all(docId) as import("../src/lib/types").StagedRow[];
  const drafts = staged.map((r) => ({
    id: r.id,
    entry_date: r.entry_date,
    particulars: r.particulars,
    ref_no: r.ref_no,
    debit_paise: r.debit_paise,
    credit_paise: r.credit_paise,
    entry_type: r.entry_type,
    gst_rate: r.gst_rate,
    settle_account: r.settle_account,
    include: r.row_no === 10 ? false : r.include === 1,
  }));
  const { journals } = postDocument(db, docId, drafts);
  assert.equal(journals, 9, "9 journals posted");
  ok("posted 9 journals in one transaction");

  step = "assert the books";
  const {
    balanceSheet,
    trialBalance,
    partyStatement,
    gstr3b,
    gstr1B2B,
    profitAndLoss,
  } = await import("../src/lib/reports");

  const zero = db
    .prepare("SELECT SUM(debit_paise) - SUM(credit_paise) AS d FROM journal_lines")
    .get() as { d: number };
  assert.equal(zero.d, 0, "journal_lines sum to zero");
  const tb = trialBalance(db);
  assert.equal(tb.balanced, true);
  ok(`trial balance = 0 (Dr = Cr = ${tb.total_debit_paise} paise)`);

  const statement = partyStatement(db, sharma!.id);
  assert.equal(statement?.closing_paise, 1_258_000, "AR Sharma Traders");
  ok("Sharma Traders statement closes at ₹12,580.00");

  const g = gstr3b(db, "2026-07");
  assert.equal(g.outward_taxable_paise, 1_600_000, "outward taxable ₹16,000.00");
  assert.equal(g.cgst_paise, 129_000, "CGST ₹1,290.00");
  assert.equal(g.sgst_paise, 129_000, "SGST ₹1,290.00");
  assert.equal(g.itc_paise, 90_000, "ITC ₹900.00");
  assert.equal(g.net_payable_paise, 168_000, "net payable ₹1,680.00");
  assert.equal(gstr1B2B(db, "2026-07").length, 4, "GSTR-1: 3 invoices + 1 credit note");
  ok("GSTR-3B: taxable ₹16,000.00 · CGST ₹1,290.00 · SGST ₹1,290.00 · ITC ₹900.00 · payable ₹1,680.00");

  const pnl = profitAndLoss(db, "2026-07");
  assert.equal(pnl.total_income_paise, 1_600_000, "P&L income");
  assert.equal(pnl.total_expense_paise, 500_000, "P&L purchases");
  ok("P&L: income ₹16,000.00 · purchases ₹5,000.00");

  const fyPnl = profitAndLoss(db, { from: "2026-04-01", to: "2027-03-31" });
  assert.equal(fyPnl.net_profit_paise, 1_100_000, "FY 2026-27 net profit");
  const settings = db
    .prepare("SELECT * FROM settings WHERE id = 1")
    .get() as import("../src/lib/types").SettingsRow;
  const bs = balanceSheet(db, "2027-03-31", settings);
  assert.equal(bs.balanced, true, "balance sheet balanced");
  assert.equal(bs.total_assets_paise, 2_158_000, "total assets ₹21,580.00");
  assert.equal(bs.current_year_profit_paise, 1_100_000, "profit injected as equity");
  assert.equal(
    bs.total_assets_paise,
    bs.total_liabilities_paise + bs.total_equity_paise,
    "A = L + E"
  );
  ok("BS 2027-03-31: assets ₹21,580.00 = liabilities + capital · profit ₹11,000.00 injected");

  step = "manual voucher + books lock";
  const { postManualVoucher } = await import("../src/lib/vouchers");
  const { dayBook } = await import("../src/lib/reports");
  const { journalId } = postManualVoucher(db, {
    kind: "journal",
    entry_date: "2026-07-20",
    memo: "Shop rent",
    ref_no: "RENT-07",
    legs: [
      { account_code: "5900", party_id: null, debit_paise: 250_000, credit_paise: 0 },
      { account_code: "1100", party_id: null, debit_paise: 0, credit_paise: 250_000 },
    ],
  });
  assert.equal(trialBalance(db).balanced, true, "TB zero after manual journal");
  const dayEntry = dayBook(db, "2026-07").find((e) => e.id === journalId);
  assert.ok(dayEntry, "day book shows the manual journal");
  assert.equal(dayEntry!.entry_type, "journal");
  assert.equal(dayEntry!.source_document_id, null);
  db.prepare("UPDATE settings SET books_locked_through = '2026-07-31' WHERE id = 1").run();
  await assert.rejects(
    async () =>
      postManualVoucher(db, {
        kind: "contra",
        entry_date: "2026-07-10",
        memo: "back-dated",
        ref_no: "",
        from: "cash",
        to: "bank",
        amount_paise: 100,
      }),
    /locked/
  );
  db.prepare("UPDATE settings SET books_locked_through = '' WHERE id = 1").run();
  ok("manual journal ₹2,500.00 posted (Dr 5900 / Cr 1100) · locked books reject back-dated voucher");

  step = "posted lock";
  await assert.rejects(() => extractDocument(docId), /posted/);
  ok("posted document is locked against re-extraction");

  step = "excel (CSV) import → review → post";
  const { parseImportCsv, TEMPLATE_HEADERS } = await import("../src/lib/import-csv");
  const partyRows = db
    .prepare("SELECT id, name FROM parties")
    .all() as { id: number; name: string }[];
  const gupta = partyRows.find((p) => p.name === "Gupta Suppliers");
  assert.ok(gupta, "demo Gupta Suppliers present");
  const csv = [
    TEMPLATE_HEADERS.join(","),
    '2026-08-02,"Cloth bill #301",301,,sale,"11,800.00",,18,cash', // blank party → doc's Sharma
    "2026-08-05,Packing inv 92,92,Gupta Suppliers,purchase,,5900,18,bank",
    "2026-08-09,Typo row,,Unknown Party,sale,10.123,,,cash", // must land excluded, not rejected
  ].join("\n");
  const parsed = parseImportCsv(csv, partyRows);
  assert.equal(parsed.included, 2, "two clean rows");
  assert.equal(parsed.excluded, 1, "bad row excluded with reason");
  // Same one-transaction shape the /api/import/excel route writes.
  const insertStaged = db.prepare(
    `INSERT INTO staged_rows
       (document_id, row_no, entry_date, particulars, ref_no, debit_paise, credit_paise,
        entry_type, gst_rate, settle_account, confidence, is_balance_row, include, party_id)
     VALUES (@document_id, @row_no, @entry_date, @particulars, @ref_no, @debit_paise, @credit_paise,
             @entry_type, @gst_rate, @settle_account, @confidence, 0, @include, @party_id)`
  );
  const importDocId = db.transaction((): number => {
    const id = db
      .prepare(
        `INSERT INTO documents
           (party_id, image_path, image_sha256, status, source_type, model, created_at, extracted_at)
         VALUES (?, 'data/uploads/smoke.csv', 'smoke-csv-sha', 'extracted', 'excel', 'csv-template', ?, ?)`
      )
      .run(sharma!.id, new Date().toISOString(), new Date().toISOString())
      .lastInsertRowid as number;
    for (const r of parsed.rows) {
      insertStaged.run({
        document_id: id,
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
    return id;
  })();
  const importStaged = db
    .prepare("SELECT * FROM staged_rows WHERE document_id = ? ORDER BY row_no")
    .all(importDocId) as import("../src/lib/types").StagedRow[];
  const importJournals = postDocument(db, importDocId, importStaged.map((r) => ({
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
  })));
  assert.equal(importJournals.journals, 2, "2 import journals posted");
  assert.equal(trialBalance(db).balanced, true, "TB zero after CSV import post");
  assert.equal(
    partyStatement(db, sharma!.id)?.closing_paise,
    1_258_000 + 1_180_000,
    "Sharma AR grew by the imported sale (doc-fallback party)"
  );
  assert.equal(
    partyStatement(db, gupta!.id)?.closing_paise,
    590_000,
    "Gupta AP carries the per-row-party purchase"
  );
  ok("CSV import: both demo parties booked · bad row excluded with reason · TB zero");

  console.log("\nSMOKE GREEN — capture → extract → review → post → reports all verified.");
  process.exit(0);
}

main().catch((e) => {
  console.error(`\nSMOKE RED at step "${step}":`);
  console.error(e);
  process.exit(1);
});
