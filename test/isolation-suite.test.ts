import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { book, type Book } from "../src/lib/book";
import { settleId } from "./helpers";
import { initSchema, seedAccountsForCompany, seedCoreData } from "../src/lib/db";
import { migrate } from "../src/lib/migrate";
import { MIGRATIONS } from "../src/lib/migrations";
import { createCompany, getCompany, updateCompanySettings } from "../src/lib/companies";
import { postManualVoucher, postVoucherWithTds } from "../src/lib/vouchers";
import {
  balanceSheet,
  dashboardStats,
  dayBook,
  gstr1B2B,
  gstr3b,
  partyStatement,
  profitAndLoss,
  trialBalance,
} from "../src/lib/reports";
import { depreciationSchedule } from "../src/lib/tax/depreciation";
import { buildComputation } from "../src/lib/tax/computation";
import { q24Summary, q26Summary, tdsRegister } from "../src/lib/tax/tds";
import { generateItems } from "../src/lib/compliance";

/**
 * RVOS-004 P6 — the isolation suite, THE ship gate for this build.
 *
 * Seeds THREE companies — A, B (deliberately distinguishable: different
 * parties, GSTINs, PANs, asset blocks, amounts) and C (onboarded but never
 * posted to — the "no data" control) — then, for every report/query
 * function the app ships, proves company A's world is unaffected by B's
 * existence and vice versa, using three independent techniques:
 *
 *   1. BEFORE/AFTER — snapshot every report against A and C, THEN create and
 *      post company B, THEN re-snapshot. If any figure moved, B leaked into
 *      A or C. This needs no hand-derived expected numbers (GST math is not
 *      re-implemented here), so it can't drift from reports.ts's own logic.
 *   2. MARKER SEARCH — reports that carry a name/GSTIN/PAN directly
 *      (statements, GSTR-1, the TDS register) are checked by searching the
 *      serialized result for the OTHER companies' marker strings. This
 *      catches a leak in ANY field, not just the ones a hand-picked
 *      assertion happened to compare.
 *   3. CROSS-ID LOOKUP — asking company A's Book for company B's party BY
 *      ITS REAL ID must return nothing, not an error and not silently the
 *      wrong party.
 *
 * The report-kind list is read from the export route's own source
 * (`src/app/api/export/[report]/route.ts`) rather than copied by hand, per
 * the spec's "enumerated FROM THE EXPORTS, not a hand-written list" — a
 * meta-test below fails loudly if that route ever ships a kind this file
 * doesn't cover yet.
 */

const FY = "2026-27";
const MONTH = "2026-06";
const FY_END = "2027-03-31";
const NOW = "2026-08-06T09:00:00.000Z";
const TODAY = "2026-08-06";

interface Co {
  id: number;
  book: Book;
  partyId: number;
  supplierId: number;
  markers: string[];
}

function suiteDb(): Database.Database {
  const db = new Database(":memory:");
  initSchema(db);
  seedCoreData(db); // company 1 = A
  migrate(db, MIGRATIONS, { now: NOW });
  return db;
}

function insertParty(
  db: Database.Database,
  companyId: number,
  p: { name: string; kind: "customer" | "supplier"; gstin?: string; stateCode?: string; pan?: string }
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO parties (company_id, name, kind, gstin, state_code, phone, pan, created_at)
         VALUES (@company_id, @name, @kind, @gstin, @stateCode, '', @pan, @now)`
      )
      .run({
        company_id: companyId,
        name: p.name,
        kind: p.kind,
        gstin: p.gstin ?? "",
        stateCode: p.stateCode ?? "",
        pan: p.pan ?? "",
        now: NOW,
      }).lastInsertRowid
  );
}

function insertAsset(
  db: Database.Database,
  companyId: number,
  a: { name: string; block: string; cost: number; purchase: string }
): void {
  db.prepare(
    `INSERT INTO fixed_assets
       (company_id, name, block, cost_paise, purchase_date, put_to_use_date, created_at)
     VALUES (@company_id, @name, @block, @cost, @purchase, @purchase, @now)`
  ).run({
    company_id: companyId,
    name: a.name,
    block: a.block,
    cost: a.cost,
    purchase: a.purchase,
    now: NOW,
  });
}

function setCompanySettings(
  db: Database.Database,
  id: number,
  o: { name: string; gstin: string; stateCode: string; pan: string; tan: string }
): void {
  updateCompanySettings(db, id, {
    companyName: o.name,
    gstin: o.gstin,
    stateCode: o.stateCode,
    country: "IN",
    currency: "INR",
    rate: 18,
    taxInclusive: 0,
    entityType: "proprietorship",
    pan: o.pan,
    tan: o.tan,
    itRegime: "new",
    presumptive: "",
    lockedThrough: "",
    fyAuditCase: 0,
  });
}

function postCompanyData(
  db: Database.Database,
  id: number,
  seed: {
    partyName: string;
    supplierName: string;
    gstin: string;
    stateCode: string;
    partyPan: string;
    supplierPan: string;
    saleAmount: number;
    tdsBase: number;
    assetName: string;
    assetBlock: string;
    assetCost: number;
    invRef: string;
    tdsRef: string;
  }
): Co {
  setCompanySettings(db, id, {
    name: seed.partyName,
    gstin: seed.gstin,
    stateCode: seed.stateCode,
    pan: seed.partyPan,
    tan: seed.supplierPan,
  });
  const partyId = insertParty(db, id, {
    name: seed.partyName,
    kind: "customer",
    gstin: seed.gstin,
    stateCode: seed.stateCode,
  });
  const supplierId = insertParty(db, id, {
    name: seed.supplierName,
    kind: "supplier",
    pan: seed.supplierPan,
  });
  const b = book(db, id);
  postManualVoucher(b, {
    kind: "sale",
    entry_date: "2026-06-10",
    memo: `${seed.partyName} sale`,
    ref_no: seed.invRef,
    party_id: partyId,
    amount_paise: seed.saleAmount,
    gst_rate: 18,
    bank_account_id: settleId(db, id, "cash"),
  });
  postVoucherWithTds(b, {
    entry_date: "2026-06-12",
    memo: `${seed.supplierName} bill`,
    ref_no: seed.tdsRef,
    party_id: supplierId,
    expense_account_code: "5900",
    base_paise: seed.tdsBase,
    section: "194C",
    bank_account_id: settleId(db, id, "bank"),
  });
  insertAsset(db, id, {
    name: seed.assetName,
    block: seed.assetBlock,
    cost: seed.assetCost,
    purchase: "2026-04-01",
  });
  return {
    id,
    book: b,
    partyId,
    supplierId,
    markers: [seed.partyName, seed.supplierName, seed.gstin, seed.partyPan, seed.supplierPan, seed.assetName],
  };
}

function assertNoMarkersLeak(result: unknown, foreignMarkers: string[], label: string): void {
  const text = JSON.stringify(result);
  for (const m of foreignMarkers) {
    if (!m) continue;
    assert.ok(!text.includes(m), `${label} leaked foreign marker "${m}": ${text.slice(0, 400)}`);
  }
}

/** Every aggregate report this suite pins for the before/after comparison. */
function snapshot(b: Book, settings: ReturnType<typeof getCompany>) {
  return {
    trialBalance: trialBalance(b),
    dayBook: dayBook(b),
    pnl: profitAndLoss(b, MONTH),
    balanceSheet: balanceSheet(b, FY_END, settings!),
    gstr3b: gstr3b(b, MONTH),
    gstr1: gstr1B2B(b, MONTH),
    dashboard: dashboardStats(b, MONTH),
    depreciation: depreciationSchedule(b, FY),
    computation: buildComputation(b, FY),
    tdsRegister: tdsRegister(b, FY),
    q26: q26Summary(b, FY, 1),
    q24: q24Summary(b, FY, 1),
    compliance: generateItems(b, FY, settings!, TODAY),
  };
}

// ---------------------------------------------------------------------------
// The enumeration itself must come from the export route, not be hand-copied
// ---------------------------------------------------------------------------

function exportedReportKinds(): string[] {
  const src = readFileSync(
    path.join(process.cwd(), "src/app/api/export/[report]/route.ts"),
    "utf8"
  );
  const kinds = new Set<string>();
  for (const m of src.matchAll(/case\s+"([a-z0-9-]+)"\s*:/g)) kinds.add(m[1]);
  return [...kinds].sort();
}

const COVERED_BY_THIS_SUITE = new Set([
  "trial-balance",
  "day-book",
  "pnl",
  "gstr-3b",
  "gstr-1",
  "statement",
  "balance-sheet",
  "depreciation",
  "computation",
  "tds-26q",
  "tds-24q",
]);

test("this suite covers every report kind the export route ships (not a hand-written list)", () => {
  const kinds = exportedReportKinds();
  const missing = kinds.filter((k) => !COVERED_BY_THIS_SUITE.has(k));
  assert.deepEqual(
    missing,
    [],
    `src/app/api/export/[report]/route.ts ships a report kind not covered by ` +
      `test/isolation-suite.test.ts: ${missing.join(", ")}. Add an isolation assertion for it here ` +
      `before shipping — this is the whole point of P6.`
  );
});

// ---------------------------------------------------------------------------
// Before/after: B's arrival must not move a single figure of A's or C's
// ---------------------------------------------------------------------------

test("every report function: company B's arrival changes nothing about company A or an empty company", () => {
  const db = suiteDb();
  const A = postCompanyData(db, 1, {
    partyName: "Alpha Traders",
    supplierName: "Alpha Contractor",
    gstin: "27AAAAA0000A1Z5",
    stateCode: "27",
    partyPan: "AAAAA1111A",
    supplierPan: "AAAA11111A",
    saleAmount: 50_000_00,
    tdsBase: 20_000_00,
    assetName: "Alpha Laptop",
    assetBlock: "computers",
    assetCost: 1_00_000_00,
    invRef: "A-INV-1",
    tdsRef: "A-TDS-1",
  });
  const C_ID = createCompany(db, { name: "Gamma Unused" }, NOW);
  seedAccountsForCompany(db, C_ID);
  const bookC = book(db, C_ID);
  // C deliberately keeps the fresh-company defaults (gstin/tan empty, no
  // parties, no postings) — this is the "no data" control the spec calls
  // out by name: it must return empty, never company 1's rows.

  const settingsA = getCompany(db, A.id);
  const settingsCBefore = getCompany(db, C_ID);
  const beforeA = snapshot(A.book, settingsA);
  const beforeC = snapshot(bookC, settingsCBefore);

  // C, with genuinely nothing posted, must be the empty/zero shape — not a
  // silent fallback to company 1's data.
  assert.deepEqual(beforeC.trialBalance.lines, []);
  assert.equal(beforeC.trialBalance.total_debit_paise, 0);
  assert.deepEqual(beforeC.dayBook, []);
  assert.equal(beforeC.pnl.total_income_paise, 0);
  assert.equal(beforeC.pnl.net_profit_paise, 0);
  assert.equal(beforeC.balanceSheet.total_assets_paise, 0);
  assert.equal(beforeC.gstr3b.net_payable_paise, 0);
  assert.deepEqual(beforeC.gstr1, []);
  assert.equal(beforeC.dashboard.journals_this_month, 0);
  assert.equal(beforeC.depreciation.total_depreciation_paise, 0);
  assert.equal(beforeC.computation.book_profit_paise, 0);
  assert.deepEqual(beforeC.tdsRegister, []);
  assert.equal(beforeC.q26.total_tds_paise, 0);

  const B_ID = createCompany(db, { name: "Beta Metals" }, NOW);
  seedAccountsForCompany(db, B_ID);
  const B = postCompanyData(db, B_ID, {
    partyName: "Beta Industries",
    supplierName: "Beta Contractor",
    gstin: "07BBBBB1111B2Z6",
    stateCode: "07",
    partyPan: "BBBBB2222B",
    supplierPan: "BBBB22222B",
    saleAmount: 75_000_00,
    tdsBase: 30_000_00,
    assetName: "Beta Machine",
    assetBlock: "plant",
    assetCost: 2_00_000_00,
    invRef: "B-INV-1",
    tdsRef: "B-TDS-1",
  });

  const afterA = snapshot(A.book, getCompany(db, A.id));
  const afterC = snapshot(bookC, getCompany(db, C_ID));

  assert.deepEqual(afterA, beforeA, "company A's reports changed after company B was created and posted to");
  assert.deepEqual(afterC, beforeC, "the empty company's reports changed after company B was created and posted to");

  // Sanity: the snapshots aren't vacuously equal because nothing ran — A's
  // own data must actually be present.
  assert.ok(afterA.trialBalance.lines.length > 0, "company A's trial balance is suspiciously empty");
  assert.ok(afterA.gstr1.length > 0, "company A's GSTR-1 is suspiciously empty");

  // And B, once it exists, must show ITS OWN data and none of A's markers.
  const bBook = B.book;
  const bSettings = getCompany(db, B.id);
  const bReports = snapshot(bBook, bSettings);
  assertNoMarkersLeak(bReports.gstr1, A.markers, "company B's GSTR-1");
  assertNoMarkersLeak(bReports.tdsRegister, A.markers, "company B's TDS register");
  assertNoMarkersLeak(afterA.gstr1, B.markers, "company A's GSTR-1");
  assertNoMarkersLeak(afterA.tdsRegister, B.markers, "company A's TDS register");
  assert.ok(bReports.gstr1.length > 0, "company B's GSTR-1 is suspiciously empty");
});

// ---------------------------------------------------------------------------
// Party statement — direct cross-company ID lookup
// ---------------------------------------------------------------------------

test("partyStatement: a company's Book cannot read another company's party, even by its real id", () => {
  const db = suiteDb();
  const A = postCompanyData(db, 1, {
    partyName: "Alpha Traders",
    supplierName: "Alpha Contractor",
    gstin: "27AAAAA0000A1Z5",
    stateCode: "27",
    partyPan: "AAAAA1111A",
    supplierPan: "AAAA11111A",
    saleAmount: 50_000_00,
    tdsBase: 20_000_00,
    assetName: "Alpha Laptop",
    assetBlock: "computers",
    assetCost: 1_00_000_00,
    invRef: "A-INV-1",
    tdsRef: "A-TDS-1",
  });
  const B_ID = createCompany(db, { name: "Beta Metals" }, NOW);
  seedAccountsForCompany(db, B_ID);
  const B = postCompanyData(db, B_ID, {
    partyName: "Beta Industries",
    supplierName: "Beta Contractor",
    gstin: "07BBBBB1111B2Z6",
    stateCode: "07",
    partyPan: "BBBBB2222B",
    supplierPan: "BBBB22222B",
    saleAmount: 75_000_00,
    tdsBase: 30_000_00,
    assetName: "Beta Machine",
    assetBlock: "plant",
    assetCost: 2_00_000_00,
    invRef: "B-INV-1",
    tdsRef: "B-TDS-1",
  });

  // Real results for each company's own party.
  const ownA = partyStatement(A.book, A.partyId);
  const ownB = partyStatement(B.book, B.partyId);
  assert.ok(ownA, "company A's own party statement should not be null");
  assert.ok(ownB, "company B's own party statement should not be null");
  assert.equal(ownA!.party.name, "Alpha Traders");
  assert.equal(ownB!.party.name, "Beta Industries");

  // The cross-company lookups — same exact, real, valid ids — must be null,
  // not the other company's party and not a thrown error.
  assert.equal(
    partyStatement(A.book, B.partyId),
    null,
    "company A's Book returned something for company B's party id"
  );
  assert.equal(
    partyStatement(B.book, A.partyId),
    null,
    "company B's Book returned something for company A's party id"
  );
});

// ---------------------------------------------------------------------------
// Settings are per company, not a shared singleton
// ---------------------------------------------------------------------------

test("company settings (GSTIN/PAN/books-lock) are per company, not shared", () => {
  const db = suiteDb();
  const A = postCompanyData(db, 1, {
    partyName: "Alpha Traders",
    supplierName: "Alpha Contractor",
    gstin: "27AAAAA0000A1Z5",
    stateCode: "27",
    partyPan: "AAAAA1111A",
    supplierPan: "AAAA11111A",
    saleAmount: 50_000_00,
    tdsBase: 20_000_00,
    assetName: "Alpha Laptop",
    assetBlock: "computers",
    assetCost: 1_00_000_00,
    invRef: "A-INV-1",
    tdsRef: "A-TDS-1",
  });
  const B_ID = createCompany(db, { name: "Beta Metals" }, NOW);
  seedAccountsForCompany(db, B_ID);
  const C_ID = createCompany(db, { name: "Gamma Unused" }, NOW);
  seedAccountsForCompany(db, C_ID);

  // B never had settings written — must show its OWN fresh defaults, not A's.
  const settingsB = getCompany(db, B_ID)!;
  assert.equal(settingsB.gstin, "");
  assert.equal(settingsB.tan, "");
  assert.equal(settingsB.books_locked_through, "");
  assert.notEqual(settingsB.gstin, getCompany(db, A.id)!.gstin);

  // Locking A's books must not touch B's or C's.
  updateCompanySettings(db, A.id, {
    companyName: "Alpha Traders",
    gstin: "27AAAAA0000A1Z5",
    stateCode: "27",
    country: "IN",
    currency: "INR",
    rate: 18,
    taxInclusive: 0,
    entityType: "proprietorship",
    pan: "AAAAA1111A",
    tan: "AAAA11111A",
    itRegime: "new",
    presumptive: "",
    lockedThrough: "2026-06-30",
    fyAuditCase: 0,
  });
  assert.equal(getCompany(db, A.id)!.books_locked_through, "2026-06-30");
  assert.equal(getCompany(db, B_ID)!.books_locked_through, "", "locking A's books also locked B's");
  assert.equal(getCompany(db, C_ID)!.books_locked_through, "", "locking A's books also locked C's");

  // The compliance rules engine reads settings per company: only a company
  // with a GSTIN/TAN on file gets GST/TDS due-date rows.
  const itemsA = generateItems(book(db, A.id), FY, getCompany(db, A.id)!, TODAY);
  const itemsC = generateItems(book(db, C_ID), FY, getCompany(db, C_ID)!, TODAY);
  assert.ok(itemsA.some((i) => i.regime === "gst"), "company A has a GSTIN and should get GST due items");
  assert.ok(itemsA.some((i) => i.regime === "tds"), "company A has a TAN and should get TDS due items");
  assert.ok(
    itemsC.every((i) => i.regime === "it"),
    `company C has no GSTIN/TAN and no TDS postings — should get only income-tax items, got: ` +
      `${[...new Set(itemsC.map((i) => i.regime))].join(", ")}`
  );
});

// ---------------------------------------------------------------------------
// The session/company-switch layer: no cache() can hold a stale Book
// ---------------------------------------------------------------------------

test("requireBook() never caches the Book itself — only the per-request session lookup is cache()'d", () => {
  const dalSrc = readFileSync(path.join(process.cwd(), "src/lib/dal.ts"), "utf8");
  const cacheWraps = dalSrc.match(/=\s*cache\(/g) ?? [];
  assert.equal(
    cacheWraps.length,
    1,
    `expected exactly one cache()-wrapped export in dal.ts (getSessionUser) — found ${cacheWraps.length}. ` +
      `If requireBook() ever gets its Book construction wrapped in cache() too, a mid-render company switch ` +
      `could resolve a stale Book bound to the OLD company — see dal.ts's own comment on requireBook() for why ` +
      `it deliberately does not do this.`
  );
  const start = dalSrc.indexOf("export async function requireBook");
  const end = dalSrc.indexOf("export async function requireApiBook");
  assert.ok(start > -1 && end > start, "could not locate requireBook()'s body in dal.ts to check it");
  const requireBookSrc = dalSrc.slice(start, end);
  assert.ok(
    !requireBookSrc.includes("cache("),
    "requireBook()'s own body must not wrap its Book construction in cache()"
  );
});
