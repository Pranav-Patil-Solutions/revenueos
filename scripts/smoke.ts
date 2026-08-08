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
  const { book: makeBook } = await import("../src/lib/book");
  const { getCompany } = await import("../src/lib/companies");
  const db = getDb();
  const book = makeBook(db, 1); // fresh single-company install — company 1
  const accounts = book.all("SELECT COUNT(*) AS n FROM accounts WHERE company_id = @company_id") as { n: number }[];
  assert.equal(accounts[0].n, SEED_ACCOUNTS.length, "chart of accounts");
  const ungrouped = book.all(
    "SELECT COUNT(*) AS n FROM accounts WHERE company_id = @company_id AND group_code IS NULL"
  ) as { n: number }[];
  assert.equal(ungrouped[0].n, 0, "every account grouped");
  const sharma = book.get(
    "SELECT id FROM parties WHERE company_id = @company_id AND name = 'Sharma Traders'"
  ) as { id: number } | undefined;
  assert.ok(sharma, "DEMO_MODE seeds Sharma Traders");
  ok(`fresh db at ${tmp} — ${SEED_ACCOUNTS.length} grouped accounts, demo parties seeded`);

  step = "fake upload";
  mkdirSync(path.join(tmp, "data", "uploads"), { recursive: true });
  writeFileSync(path.join(tmp, "data", "uploads", "smoke.jpg"), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  const docId = Number(
    book.run(
      `INSERT INTO documents (company_id, party_id, image_path, image_sha256, status, created_at)
       VALUES (@company_id, @partyId, 'data/uploads/smoke.jpg', 'smoke-sha', 'uploaded', @now)`,
      { partyId: sharma!.id, now: new Date().toISOString() }
    ).lastInsertRowid
  );
  ok(`document #${docId} uploaded`);

  step = "DEMO extraction";
  const { extractDocument } = await import("../src/lib/extraction");
  const { rows } = await extractDocument(book, docId);
  assert.equal(rows, 11, "fixture has 11 rows");
  const excluded = book.all(
    "SELECT COUNT(*) AS n FROM staged_rows WHERE company_id = @company_id AND document_id = @docId AND include = 0",
    { docId }
  ) as { n: number }[];
  assert.equal(excluded[0].n, 1, "balance row auto-excluded");
  ok("extracted 11 rows, balance row pre-excluded");

  step = "review + post (row 10 excluded)";
  const { postDocument } = await import("../src/lib/posting");
  const staged = book.all(
    "SELECT * FROM staged_rows WHERE company_id = @company_id AND document_id = @docId ORDER BY row_no",
    { docId }
  ) as import("../src/lib/types").StagedRow[];
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
  const { journals } = postDocument(book, docId, drafts);
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

  const zero = book.get(
    "SELECT SUM(debit_paise) - SUM(credit_paise) AS d FROM journal_lines WHERE company_id = @company_id"
  ) as { d: number };
  assert.equal(zero.d, 0, "journal_lines sum to zero");
  const tb = trialBalance(book);
  assert.equal(tb.balanced, true);
  ok(`trial balance = 0 (Dr = Cr = ${tb.total_debit_paise} paise)`);

  const statement = partyStatement(book, sharma!.id);
  assert.equal(statement?.closing_paise, 1_258_000, "AR Sharma Traders");
  ok("Sharma Traders statement closes at ₹12,580.00");

  const g = gstr3b(book, "2026-07");
  assert.equal(g.outward_taxable_paise, 1_600_000, "outward taxable ₹16,000.00");
  assert.equal(g.cgst_paise, 129_000, "CGST ₹1,290.00");
  assert.equal(g.sgst_paise, 129_000, "SGST ₹1,290.00");
  assert.equal(g.itc_paise, 90_000, "ITC ₹900.00");
  assert.equal(g.net_payable_paise, 168_000, "net payable ₹1,680.00");
  assert.equal(gstr1B2B(book, "2026-07").length, 4, "GSTR-1: 3 invoices + 1 credit note");
  ok("GSTR-3B: taxable ₹16,000.00 · CGST ₹1,290.00 · SGST ₹1,290.00 · ITC ₹900.00 · payable ₹1,680.00");

  const pnl = profitAndLoss(book, "2026-07");
  assert.equal(pnl.total_income_paise, 1_600_000, "P&L income");
  assert.equal(pnl.total_expense_paise, 500_000, "P&L purchases");
  ok("P&L: income ₹16,000.00 · purchases ₹5,000.00");

  const fyPnl = profitAndLoss(book, { from: "2026-04-01", to: "2027-03-31" });
  assert.equal(fyPnl.net_profit_paise, 1_100_000, "FY 2026-27 net profit");
  const settings = getCompany(book.db, book.companyId)!;
  const bs = balanceSheet(book, "2027-03-31", settings);
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
  const { journalId } = postManualVoucher(book, {
    kind: "journal",
    entry_date: "2026-07-20",
    memo: "Shop rent",
    ref_no: "RENT-07",
    legs: [
      { account_code: "5900", party_id: null, debit_paise: 250_000, credit_paise: 0 },
      { account_code: "1100", party_id: null, debit_paise: 0, credit_paise: 250_000 },
    ],
  });
  assert.equal(trialBalance(book).balanced, true, "TB zero after manual journal");
  const dayEntry = dayBook(book, "2026-07").find((e) => e.id === journalId);
  assert.ok(dayEntry, "day book shows the manual journal");
  assert.equal(dayEntry!.entry_type, "journal");
  assert.equal(dayEntry!.source_document_id, null);
  book.db
    .prepare("UPDATE companies SET books_locked_through = @val WHERE id = @company_id")
    .run({ val: "2026-07-31", company_id: book.companyId });
  await assert.rejects(
    async () =>
      postManualVoucher(book, {
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
  book.db
    .prepare("UPDATE companies SET books_locked_through = @val WHERE id = @company_id")
    .run({ val: "", company_id: book.companyId });
  ok("manual journal ₹2,500.00 posted (Dr 5900 / Cr 1100) · locked books reject back-dated voucher");

  step = "posted lock";
  await assert.rejects(() => extractDocument(book, docId), /posted/);
  ok("posted document is locked against re-extraction");

  step = "excel (CSV) import → review → post";
  const { parseImportCsv, TEMPLATE_HEADERS } = await import("../src/lib/import-csv");
  const partyRows = book.all("SELECT id, name FROM parties WHERE company_id = @company_id") as {
    id: number;
    name: string;
  }[];
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
  const insertStagedSql = `INSERT INTO staged_rows
       (company_id, document_id, row_no, entry_date, particulars, ref_no, debit_paise, credit_paise,
        entry_type, gst_rate, settle_account, confidence, is_balance_row, include, party_id)
     VALUES (@company_id, @document_id, @row_no, @entry_date, @particulars, @ref_no, @debit_paise, @credit_paise,
             @entry_type, @gst_rate, @settle_account, @confidence, 0, @include, @party_id)`;
  const importDocId = book.tx((b): number => {
    const id = b.run(
      `INSERT INTO documents
           (company_id, party_id, image_path, image_sha256, status, source_type, model, created_at, extracted_at)
         VALUES (@company_id, @partyId, 'data/uploads/smoke.csv', 'smoke-csv-sha', 'extracted', 'excel', 'csv-template', @now, @now)`,
      { partyId: sharma!.id, now: new Date().toISOString() }
    ).lastInsertRowid as number;
    for (const r of parsed.rows) {
      b.run(insertStagedSql, {
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
  });
  const importStaged = book.all(
    "SELECT * FROM staged_rows WHERE company_id = @company_id AND document_id = @docId ORDER BY row_no",
    { docId: importDocId }
  ) as import("../src/lib/types").StagedRow[];
  const importJournals = postDocument(book, importDocId, importStaged.map((r) => ({
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
  assert.equal(trialBalance(book).balanced, true, "TB zero after CSV import post");
  assert.equal(
    partyStatement(book, sharma!.id)?.closing_paise,
    1_258_000 + 1_180_000,
    "Sharma AR grew by the imported sale (doc-fallback party)"
  );
  assert.equal(
    partyStatement(book, gupta!.id)?.closing_paise,
    590_000,
    "Gupta AP carries the per-row-party purchase"
  );
  ok("CSV import: both demo parties booked · bad row excluded with reason · TB zero");

  step = "tally (day book XML) import → map ledgers → review → post";
  const { parseDayBook, tallyVouchersToRows } = await import("../src/lib/import-tally");
  const accountsByCode = new Map(
    (book.all("SELECT id, code FROM accounts WHERE company_id = @company_id") as { id: number; code: string }[]).map(
      (a) => [a.code, a.id]
    )
  );
  // Posts in 2026-09, after every pinned July/FY assertion above has run.
  const dayBookXml = `<ENVELOPE><BODY><IMPORTDATA><REQUESTDATA><TALLYMESSAGE>
   <VOUCHER VCHTYPE="Sales"><DATE>20260902</DATE><VOUCHERTYPENAME>Sales</VOUCHERTYPENAME>
    <VOUCHERNUMBER>401</VOUCHERNUMBER><NARRATION>Tally sale #401</NARRATION>
    <ALLLEDGERENTRIES.LIST><LEDGERNAME>Sharma Traders</LEDGERNAME><AMOUNT>-11800.00</AMOUNT></ALLLEDGERENTRIES.LIST>
    <ALLLEDGERENTRIES.LIST><LEDGERNAME>Sales Account</LEDGERNAME><AMOUNT>10000.00</AMOUNT></ALLLEDGERENTRIES.LIST>
    <ALLLEDGERENTRIES.LIST><LEDGERNAME>Output CGST</LEDGERNAME><AMOUNT>900.00</AMOUNT></ALLLEDGERENTRIES.LIST>
    <ALLLEDGERENTRIES.LIST><LEDGERNAME>Output SGST</LEDGERNAME><AMOUNT>900.00</AMOUNT></ALLLEDGERENTRIES.LIST>
   </VOUCHER>
   <VOUCHER VCHTYPE="Receipt"><DATE>20260905</DATE><VOUCHERTYPENAME>Receipt</VOUCHERTYPENAME>
    <VOUCHERNUMBER>R-40</VOUCHERNUMBER><NARRATION>Against #401</NARRATION>
    <ALLLEDGERENTRIES.LIST><LEDGERNAME>Bank of Baroda</LEDGERNAME><AMOUNT>-5000.00</AMOUNT></ALLLEDGERENTRIES.LIST>
    <ALLLEDGERENTRIES.LIST><LEDGERNAME>Sharma Traders</LEDGERNAME><AMOUNT>5000.00</AMOUNT></ALLLEDGERENTRIES.LIST>
   </VOUCHER>
   <VOUCHER VCHTYPE="Journal"><DATE>20260909</DATE><VOUCHERTYPENAME>Journal</VOUCHERTYPENAME>
    <VOUCHERNUMBER>J-40</VOUCHERNUMBER><NARRATION>Rent accrual</NARRATION>
    <ALLLEDGERENTRIES.LIST><LEDGERNAME>Rent</LEDGERNAME><AMOUNT>-2500.00</AMOUNT></ALLLEDGERENTRIES.LIST>
    <ALLLEDGERENTRIES.LIST><LEDGERNAME>Outstanding Rent</LEDGERNAME><AMOUNT>2500.00</AMOUNT></ALLLEDGERENTRIES.LIST>
   </VOUCHER>
  </TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;
  const tallyVouchers = parseDayBook(dayBookXml);
  assert.equal(tallyVouchers.length, 3, "3 vouchers in the day book");

  // The mapping the UI form would save — persisted, so a second import asks nothing.
  const nowIso = new Date().toISOString();
  const ledgerTargets: [string, string, number | null, number | null][] = [
    ["Sharma Traders", "party", null, sharma!.id],
    ["Sales Account", "account", accountsByCode.get("4000")!, null],
    ["Output CGST", "account", accountsByCode.get("2200")!, null],
    ["Output SGST", "account", accountsByCode.get("2210")!, null],
    ["Bank of Baroda", "account", accountsByCode.get("1100")!, null],
  ];
  for (const [ledger_name, target_kind, account_id, party_id] of ledgerTargets) {
    book.run(
      `INSERT INTO ledger_mappings (company_id, ledger_name, target_kind, account_id, party_id, created_at)
       VALUES (@company_id, @ledger_name, @target_kind, @account_id, @party_id, @created_at)
       ON CONFLICT(company_id, ledger_name) DO UPDATE SET
         target_kind = excluded.target_kind,
         account_id  = excluded.account_id,
         party_id    = excluded.party_id`,
      { ledger_name, target_kind, account_id, party_id, created_at: nowIso }
    );
  }
  const { unmappedLedgers } = await import("../src/lib/import-tally");
  const savedMappings = book.all(
    "SELECT * FROM ledger_mappings WHERE company_id = @company_id"
  ) as import("../src/lib/import-tally").LedgerMapping[];
  assert.deepEqual(
    unmappedLedgers(tallyVouchers, savedMappings),
    [],
    "saved mappings cover every importable ledger"
  );

  const tallyParsed = tallyVouchersToRows(
    tallyVouchers,
    savedMappings,
    book.all("SELECT id, code, type FROM accounts WHERE company_id = @company_id") as import(
      "../src/lib/import-tally"
    ).MappedAccount[],
    { taxInclusive: true }
  );
  assert.equal(tallyParsed.included, 2, "sale + receipt import; journal does not");
  assert.equal(tallyParsed.excluded, 1, "journal excluded with a reason");
  assert.match(tallyParsed.rows[2].reason, /post it manually via Vouchers/);

  const tallyDocId = book.tx((b): number => {
    const id = b.run(
      `INSERT INTO documents
           (company_id, party_id, image_path, image_sha256, status, source_type, model, created_at, extracted_at)
         VALUES (@company_id, @partyId, 'data/uploads/smoke-daybook.xml', 'smoke-tally-sha', 'extracted', 'tally', 'tally-daybook', @now, @now)`,
      { partyId: sharma!.id, now: nowIso }
    ).lastInsertRowid as number;
    for (const r of tallyParsed.rows) {
      b.run(insertStagedSql, {
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
  });
  const tallyStaged = book.all(
    "SELECT * FROM staged_rows WHERE company_id = @company_id AND document_id = @docId ORDER BY row_no",
    { docId: tallyDocId }
  ) as import("../src/lib/types").StagedRow[];
  const tallyPosted = postDocument(book, tallyDocId, tallyStaged.map((r) => ({
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
  assert.equal(tallyPosted.journals, 2, "2 tally journals posted");
  assert.equal(trialBalance(book).balanced, true, "TB zero after tally import post");
  assert.equal(
    partyStatement(book, sharma!.id)?.closing_paise,
    1_258_000 + 1_180_000 + 1_180_000 - 500_000,
    "Sharma AR carries the tally sale less the tally receipt"
  );
  ok("Tally import: ledgers mapped once · sale + receipt posted · journal excluded · TB zero");

  step = "depreciation: asset → block schedule → posted FY entry";
  const { blockFor, depreciationSchedule, postedDepreciation } = await import(
    "../src/lib/tax/depreciation"
  );
  // ₹1,00,000 of computers put to use in November = under 180 days, so the
  // 40% block rate halves to 20% → ₹20,000 for the year.
  book.run(
    `INSERT INTO fixed_assets (company_id, name, block, cost_paise, purchase_date, put_to_use_date, created_at)
     VALUES (@company_id, 'Billing laptop', 'computers', 10000000, '2026-11-01', '2026-11-01', @now)`,
    { now: nowIso }
  );
  const depFy = "2026-27";
  const schedule = depreciationSchedule(book, depFy);
  const computers = schedule.blocks.find((b) => b.block === "computers")!;
  assert.equal(computers.additions_half_paise, 10_000_000, "addition at half rate");
  assert.equal(computers.additions_full_paise, 0, "not a full-rate addition");
  assert.equal(computers.depreciation_paise, 2_000_000, "half of 40% = ₹20,000");
  assert.equal(computers.closing_paise, 8_000_000, "closing WDV ₹80,000");
  assert.equal(schedule.total_depreciation_paise, 2_000_000, "nothing else to depreciate");
  assert.equal(blockFor("computers")!.rate, 40, "computers block is 40%");

  assert.equal(postedDepreciation(book, depFy), undefined, "not posted yet");
  const dep = postManualVoucher(book, {
    kind: "journal",
    entry_type: "depreciation",
    entry_date: "2027-03-31",
    memo: "Depreciation for FY 2026-27 (IT-Act WDV)",
    ref_no: `DEP-${depFy}`,
    legs: [
      { account_code: "5800", party_id: null, debit_paise: schedule.total_depreciation_paise, credit_paise: 0 },
      { account_code: "1590", party_id: null, debit_paise: 0, credit_paise: schedule.total_depreciation_paise },
    ],
  });
  assert.equal(postedDepreciation(book, depFy)?.id, dep.journalId, "guard sees the entry");
  assert.equal(postedDepreciation(book, "2027-28"), undefined, "next FY still open");
  assert.equal(trialBalance(book).balanced, true, "TB zero after depreciation");

  // The charge lands in the P&L and the accumulated account nets off the block
  // on the balance sheet — both dated inside FY 2026-27.
  const depPnl = profitAndLoss(book, { from: "2026-04-01", to: "2027-03-31" });
  assert.equal(
    depPnl.total_expense_paise,
    500_000 + // July khata purchases
      250_000 + // manual rent journal
      500_000 + // August CSV-import purchase (taxable of the ₹5,900 bill)
      2_000_000, // this depreciation charge
    "FY expenses now carry the depreciation charge"
  );
  const depBs = balanceSheet(book, "2027-03-31", getCompany(book.db, book.companyId)!);
  assert.equal(depBs.balanced, true, "BS still balances after depreciation");
  ok("Depreciation: ₹1,00,000 computers mid-year → ₹20,000 at half of 40% · posted Dr 5800/Cr 1590 · TB zero · BS balanced");

  step = "income-tax computation (proprietorship, new regime)";
  const { buildComputation } = await import("../src/lib/tax/computation");
  const comp = buildComputation(book, depFy);

  // 2026-27 rates were verified against the gazette texts (2026-07-21) —
  // the computation must now be caveat-free, and would regress loudly if a
  // rate table lost its verification.
  assert.equal(comp.provisional, false, "2026-27 has its own verified table");
  assert.equal(comp.caveat, "", "verified year computes caveat-free");

  // Income ₹36,000 (July khata ₹16,000 + CSV sale ₹10,000 + Tally sale
  // ₹10,000, all taxable-of-gross) less ₹32,500 of expenses.
  assert.equal(comp.turnover_paise, 3_600_000, "FY turnover ₹36,000");
  assert.equal(comp.book_profit_paise, 350_000, "book profit ₹3,500");
  // The depreciation bridge nets to zero here: the books charged exactly what
  // the Act allows, so it comes out and goes back in at the same figure.
  assert.equal(comp.book_depreciation_paise, 2_000_000, "book charge added back");
  assert.equal(comp.it_depreciation_paise, 2_000_000, "Act figure deducted");
  assert.equal(comp.gross_total_income_paise, 350_000, "GTI ₹3,500");
  assert.equal(comp.taxable_income_paise, 350_000, "already a ₹10 multiple");
  assert.equal(comp.entity_type, "proprietorship");
  assert.equal(comp.tax.total_tax_paise, 0, "nil — below the first slab");
  assert.equal(comp.net_payable_paise, 0);
  assert.equal(
    comp.advance_tax.every((i) => i.instalment_paise === 0),
    true,
    "nothing owed, nothing scheduled"
  );
  ok("Computation: turnover ₹36,000 · book profit ₹3,500 · dep bridge nets to nil · tax NIL · 2026-27 rates verified, no caveat");

  step = "tds: deduct on payment → 26Q → challan deposit";
  // Posts in 2026-10 (Q3), AFTER the computation leg has pinned its FY
  // figures — the expense would otherwise shift book profit.
  const { postVoucherWithTds } = await import("../src/lib/vouchers");
  const { q26Summary } = await import("../src/lib/tax/tds");
  // Without a PAN the engine correctly deducts the penal 20% — record the
  // payee's PAN first so this leg pins the section rate.
  book.run("UPDATE parties SET pan = @pan WHERE id = @id AND company_id = @company_id", {
    pan: "ABCPG1234H",
    id: gupta!.id,
  });
  const tdsPost = postVoucherWithTds(book, {
    entry_date: "2026-10-15",
    memo: "Shed repair contractor",
    ref_no: "TDS-SMOKE",
    party_id: gupta!.id,
    expense_account_code: "5900",
    base_paise: 1_000_000, // ₹10,000
    section: "194C",
    settle_account: "bank",
  });
  assert.equal(tdsPost.computation.tds_paise, 10_000, "1% of ₹10,000 = ₹100");
  const bal2300 = () =>
    (
      book.get(
        `SELECT COALESCE(SUM(jl.debit_paise) - SUM(jl.credit_paise), 0) b
         FROM journal_lines jl
         JOIN accounts a ON a.id = jl.account_id AND a.company_id = @company_id
         WHERE jl.company_id = @company_id AND a.code = '2300'`
      ) as { b: number }
    ).b;
  assert.equal(bal2300(), -10_000, "₹100 held in TDS Payable");
  const q3 = q26Summary(book, "2026-27", 3);
  assert.equal(q3.lines.length, 1, "26Q Q3 shows one payee line");
  assert.equal(q3.total_tds_paise, 10_000);
  assert.equal(q3.undeposited_paise, 10_000);

  // Deposit: same one-transaction shape as the createTdsChallan action.
  book.tx((b) => {
    const depVoucher = postManualVoucher(b, {
      kind: "journal",
      entry_type: "tds_challan",
      entry_date: "2026-11-07",
      memo: "TDS deposit — Q3 FY 2026-27",
      ref_no: "CHLN-SMOKE",
      legs: [
        { account_code: "2300", party_id: null, debit_paise: 10_000, credit_paise: 0 },
        { account_code: "1100", party_id: null, debit_paise: 0, credit_paise: 10_000 },
      ],
    });
    const challanId = b.run(
      `INSERT INTO tds_challans (company_id, fy, quarter, form, challan_no, bsr_code, paid_on, amount_paise, journal_id, created_at)
       VALUES (@company_id, '2026-27', 3, '26Q', 'CHLN-SMOKE', '0001234', '2026-11-07', 10000, @journalId, @now)`,
      { journalId: depVoucher.journalId, now: new Date().toISOString() }
    ).lastInsertRowid as number;
    b.run(
      `UPDATE tds_entries SET challan_id = @challanId
       WHERE company_id = @company_id AND challan_id IS NULL
         AND entry_date BETWEEN '2026-10-01' AND '2026-12-31'`,
      { challanId }
    );
  });
  assert.equal(bal2300(), 0, "challan clears 2300 to zero");
  assert.equal(q26Summary(book, "2026-27", 3).undeposited_paise, 0);
  assert.equal(trialBalance(book).balanced, true, "TB zero after TDS cycle");
  ok("TDS: 194C ₹10,000 → ₹100 held in 2300 · 26Q one line · challan deposit → 2300 zero · TB zero");

  step = "compliance: board → mark done → regenerate";
  // Marks are metadata, never journals — this leg cannot move any pinned
  // figure. The smoke db has no GSTIN, but the TDS leg above posted a real
  // deduction, so the TDS rows must switch on by themselves.
  const { generateItems } = await import("../src/lib/compliance");
  const smokeSettings = getCompany(book.db, book.companyId)!;
  assert.equal(smokeSettings.gstin, "", "smoke books carry no GSTIN");
  const board = generateItems(book, "2026-27", smokeSettings, "2026-11-01");
  assert.equal(board.length, 21, "16 TDS + 4 advance tax + 1 ITR, no GST rows");
  const octDeposit = board.find(
    (i) => i.rule_code === "tds-deposit" && i.period === "2026-10"
  );
  assert.ok(octDeposit, "October deposit on the board");
  assert.equal(octDeposit!.due_date, "2026-11-07");
  assert.equal(octDeposit!.status, "pending");
  book.run(
    `INSERT INTO compliance_marks (company_id, rule_code, period, status, marked_at, note)
     VALUES (@company_id, 'tds-deposit', '2026-10', 'done', @now, 'CHLN-SMOKE')`,
    { now: new Date().toISOString() }
  );
  const after = generateItems(book, "2026-27", smokeSettings, "2026-11-08");
  const marked = after.find(
    (i) => i.rule_code === "tds-deposit" && i.period === "2026-10"
  )!;
  assert.equal(marked.status, "done", "mark survives regeneration");
  assert.equal(marked.note, "CHLN-SMOKE");
  const sept = after.find(
    (i) => i.rule_code === "tds-deposit" && i.period === "2026-09"
  )!;
  assert.equal(sept.status, "overdue", "unmarked sibling derives overdue");
  assert.equal(trialBalance(book).balanced, true, "TB untouched by marks");
  ok("Compliance: 21-item board (TDS auto-on, GST off) · Oct deposit marked done · regenerate shows it · sibling overdue");

  step = "ca pack: composition + reconciliations";
  // The pack composes the SAME functions the pages use, so this leg asserts
  // the pack-level reconciliation properties instead of re-pinning figures.
  // It posts nothing — safe after every earlier pin.
  const packSettings = getCompany(book.db, book.companyId)!;
  const packBs = balanceSheet(book, "2027-03-31", packSettings);
  const packBsLines = packBs.groups.flatMap((g) => g.lines);
  const packAr = packBsLines.find((l) => l.code === "1200")?.amount_paise ?? 0;
  const packAp = packBsLines.find((l) => l.code === "2100")?.amount_paise ?? 0;
  // Both sides of every party: own ledger AND cross ledger, dated at FY end —
  // a customer's payable belongs in creditors or the AP control won't tie
  // (this exact assert caught the own-ledger-only annexure in the build).
  let packDebtors = 0;
  let packCreditors = 0;
  for (const p of book.all("SELECT id, kind FROM parties WHERE company_id = @company_id") as {
    id: number;
    kind: string;
  }[]) {
    const st = partyStatement(book, p.id, "2027-03-31");
    if (!st) continue;
    if (p.kind === "customer") {
      packDebtors += st.closing_paise;
      packCreditors += st.cross_ledger_paise;
    } else {
      packCreditors += st.closing_paise;
      packDebtors += st.cross_ledger_paise;
    }
  }
  assert.equal(packDebtors, packAr, "annexure debtors reconcile to the AR control");
  assert.equal(packCreditors, packAp, "annexure creditors reconcile to the AP control");
  const { monthsOfFy } = await import("../src/lib/fy");
  const packGst = monthsOfFy("2026-27").map((m) => gstr3b(book, m));
  assert.equal(packGst.length, 12, "GST sweep covers the FY incl. the Dec→Jan seam");
  const packComp = buildComputation(book, "2026-27");
  assert.equal(packComp.caveat, "", "verified 2026-27: pack renders no rates caveat");
  const { TDS_SECTIONS } = await import("../src/lib/tax/tds");
  assert.ok(
    TDS_SECTIONS.every((s) => s.verified === true),
    "TDS sections verified — the pack's unconfirmed banner stays hidden"
  );
  const packPosted = postedDepreciation(book, "2026-27");
  const packSchedule = depreciationSchedule(book, "2026-27");
  assert.ok(packPosted, "smoke books carry the posted depreciation entry");
  assert.equal(
    packPosted!.amount_paise,
    packSchedule.total_depreciation_paise,
    "pack drift check: schedule matches the posted journal"
  );
  ok("CA pack: annexure == AR/AP controls · 12-month GST sweep · caveats travel · dep schedule == posted journal");

  console.log("\nSMOKE GREEN — capture → extract → review → post → reports all verified.");
  process.exit(0);
}

main().catch((e) => {
  console.error(`\nSMOKE RED at step "${step}":`);
  console.error(e);
  process.exit(1);
});
