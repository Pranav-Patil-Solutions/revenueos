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

  step = "posted lock";
  await assert.rejects(() => extractDocument(docId), /posted/);
  ok("posted document is locked against re-extraction");

  console.log("\nSMOKE GREEN — capture → extract → review → post → reports all verified.");
  process.exit(0);
}

main().catch((e) => {
  console.error(`\nSMOKE RED at step "${step}":`);
  console.error(e);
  process.exit(1);
});
