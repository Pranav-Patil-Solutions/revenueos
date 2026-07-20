import { strict as assert } from "node:assert";
import { test } from "node:test";
import Database from "better-sqlite3";
import { initSchema, seedCoreData } from "../src/lib/db";
import { trialBalance } from "../src/lib/reports";
import {
  blockFor,
  blockWdv,
  daysInUse,
  depreciationSchedule,
  HALF_YEAR_DAYS,
  IT_BLOCKS,
  postedDepreciation,
} from "../src/lib/tax/depreciation";
import { postManualVoucher } from "../src/lib/vouchers";

const COMPUTERS = blockFor("computers")!; // 40%
const PLANT = blockFor("plant")!; // 15%
const LAKH = 10_000_000; // ₹1,00,000 in paise

function assetsDb(): Database.Database {
  const db = new Database(":memory:");
  initSchema(db);
  seedCoreData(db);
  return db;
}

function addAsset(
  db: Database.Database,
  a: {
    name?: string;
    block?: string;
    cost?: number;
    purchase?: string;
    putToUse?: string | null;
  }
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO fixed_assets
           (name, block, cost_paise, purchase_date, put_to_use_date, created_at)
         VALUES (?, ?, ?, ?, ?, '2026-01-01T00:00:00Z')`
      )
      .run(
        a.name ?? "Asset",
        a.block ?? "computers",
        a.cost ?? LAKH,
        a.purchase ?? "2026-04-01",
        a.putToUse === undefined ? (a.purchase ?? "2026-04-01") : a.putToUse
      ).lastInsertRowid
  );
}

// ---------------------------------------------------------------------------
// The half-year rule
// ---------------------------------------------------------------------------

test("daysInUse counts both end days, to 31 March", () => {
  assert.equal(daysInUse("2026-04-01", "2026-27"), 365);
  assert.equal(daysInUse("2027-03-31", "2026-27"), 1);
  // The exact boundary: 3 Oct is the last date that still reaches 180 days.
  assert.equal(daysInUse("2026-10-03", "2026-27"), HALF_YEAR_DAYS);
  assert.equal(daysInUse("2026-10-04", "2026-27"), HALF_YEAR_DAYS - 1);
});

test("180-day boundary flips the rate — one day either side of 3 Oct", () => {
  const full = assetsDb();
  addAsset(full, { purchase: "2026-10-03" });
  const onBoundary = blockWdv(full, "2026-27", COMPUTERS);
  assert.equal(onBoundary.additions_full_paise, LAKH);
  assert.equal(onBoundary.additions_half_paise, 0);
  assert.equal(onBoundary.depreciation_paise, 4_000_000); // full 40%

  const half = assetsDb();
  addAsset(half, { purchase: "2026-10-04" });
  const dayLater = blockWdv(half, "2026-27", COMPUTERS);
  assert.equal(dayLater.additions_full_paise, 0);
  assert.equal(dayLater.additions_half_paise, LAKH);
  assert.equal(dayLater.depreciation_paise, 2_000_000); // half rate, 20%
  assert.equal(dayLater.closing_paise, 8_000_000);
});

test("an asset not yet put to use is in the register but not depreciated", () => {
  const db = assetsDb();
  addAsset(db, { purchase: "2026-05-01", putToUse: null });
  const b = blockWdv(db, "2026-27", COMPUTERS);
  assert.equal(b.additions_full_paise, 0);
  assert.equal(b.additions_half_paise, 0);
  assert.equal(b.depreciation_paise, 0);
});

// ---------------------------------------------------------------------------
// Roll-forward and openings
// ---------------------------------------------------------------------------

test("block rolls forward: half rate in year one, full rate on the WDV after", () => {
  const db = assetsDb();
  addAsset(db, { purchase: "2026-11-01" }); // < 180 days

  const y1 = blockWdv(db, "2026-27", COMPUTERS);
  assert.equal(y1.opening_paise, 0);
  assert.equal(y1.depreciation_paise, 2_000_000); // ₹20,000 at half of 40%
  assert.equal(y1.closing_paise, 8_000_000);

  const y2 = blockWdv(db, "2027-28", COMPUTERS);
  assert.equal(y2.opening_paise, 8_000_000); // last year's closing
  assert.equal(y2.depreciation_paise, 3_200_000); // full 40% of ₹80,000
  assert.equal(y2.closing_paise, 4_800_000);

  const y3 = blockWdv(db, "2028-29", COMPUTERS);
  assert.equal(y3.opening_paise, 4_800_000);
  assert.equal(y3.depreciation_paise, 1_920_000);
});

test("a wdv_openings row overrides the rolled-forward opening for that FY", () => {
  const db = assetsDb();
  addAsset(db, { purchase: "2026-04-01" }); // full year, 40%
  // Books brought in from the previous accountant: the block really opened
  // FY27-28 at ₹50,000, not at the ₹60,000 our own roll-forward computed.
  assert.equal(blockWdv(db, "2027-28", COMPUTERS).opening_paise, 6_000_000);
  db.prepare(
    `INSERT INTO wdv_openings (fy, block, opening_paise, created_at)
     VALUES ('2027-28', 'computers', 5000000, '2026-01-01T00:00:00Z')`
  ).run();

  const y2 = blockWdv(db, "2027-28", COMPUTERS);
  assert.equal(y2.opening_paise, 5_000_000);
  assert.equal(y2.opening_overridden, true);
  assert.equal(y2.depreciation_paise, 2_000_000); // 40% of ₹50,000
  // And the override carries into the years after it.
  assert.equal(blockWdv(db, "2028-29", COMPUTERS).opening_paise, 3_000_000);
});

test("an FY before any asset exists is an empty block, not an error", () => {
  const db = assetsDb();
  addAsset(db, { purchase: "2026-04-01" });
  const early = blockWdv(db, "2024-25", COMPUTERS);
  assert.equal(early.opening_paise, 0);
  assert.equal(early.depreciation_paise, 0);
  assert.equal(early.closing_paise, 0);
});

// ---------------------------------------------------------------------------
// Disposals
// ---------------------------------------------------------------------------

test("disposal proceeds come out of the block and reduce that year's charge", () => {
  const db = assetsDb();
  const id = addAsset(db, { purchase: "2026-04-01", cost: 20 * LAKH }); // ₹20,00,000
  db.prepare(
    "UPDATE fixed_assets SET disposed_date = '2027-06-01', disposal_paise = ? WHERE id = ?"
  ).run(5 * LAKH, id); // sold for ₹5,00,000 next year

  const y2 = blockWdv(db, "2027-28", COMPUTERS);
  assert.equal(y2.opening_paise, 12 * LAKH); // ₹20,00,000 less 40%
  assert.equal(y2.disposals_paise, 5 * LAKH);
  // 40% of (₹12,00,000 − ₹5,00,000) = ₹2,80,000
  assert.equal(y2.depreciation_paise, 28_000_000);
  assert.equal(y2.closing_paise, 42_000_000); // ₹4,20,000
});

test("proceeds above the block's value are capped — never negative depreciation", () => {
  const db = assetsDb();
  const id = addAsset(db, { purchase: "2026-04-01" });
  db.prepare(
    "UPDATE fixed_assets SET disposed_date = '2027-06-01', disposal_paise = ? WHERE id = ?"
  ).run(999 * LAKH, id);

  const y2 = blockWdv(db, "2027-28", COMPUTERS);
  assert.equal(y2.disposals_paise, 6_000_000); // capped at the ₹60,000 opening
  assert.equal(y2.depreciation_paise, 0); // block emptied — nothing to charge
  assert.equal(y2.closing_paise, 0);
  assert.ok(y2.closing_paise >= 0);
});

test("disposals hit the full-rate pool before the half-rate additions", () => {
  const db = assetsDb();
  const old = addAsset(db, { purchase: "2026-04-01", cost: 10 * LAKH });
  addAsset(db, { name: "New", purchase: "2027-11-01", cost: 10 * LAKH }); // half rate
  db.prepare(
    "UPDATE fixed_assets SET disposed_date = '2027-06-01', disposal_paise = ? WHERE id = ?"
  ).run(60 * LAKH, old);

  const y2 = blockWdv(db, "2027-28", COMPUTERS);
  // The ₹60,00,000 sale is capped at the whole block (₹6,00,000 opening plus
  // the ₹10,00,000 half-rate addition): both pools are emptied, so the year's
  // charge is nil rather than negative.
  assert.equal(y2.opening_paise, 6 * LAKH);
  assert.equal(y2.additions_half_paise, 10 * LAKH);
  assert.equal(y2.disposals_paise, 16 * LAKH);
  assert.equal(y2.depreciation_paise, 0);
  assert.equal(y2.closing_paise, 0);
});

test("an asset never put to use can't take proceeds out of the block", () => {
  // Its cost was never added, so letting the sale out would shrink the block
  // and quietly cut the depreciation of every other asset in it.
  //
  // Run against a fixed_assets table WITHOUT the timeline CHECKs — the shape
  // every db created before those CHECKs still has, since CREATE TABLE IF NOT
  // EXISTS never revisits an existing table. blockWdv must hold the line on
  // its own, not lean on the schema.
  const db = assetsDb();
  db.exec(`
    DROP TABLE fixed_assets;
    CREATE TABLE fixed_assets (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, block TEXT NOT NULL,
      cost_paise INTEGER NOT NULL, purchase_date TEXT NOT NULL,
      put_to_use_date TEXT, disposed_date TEXT, disposal_paise INTEGER,
      created_at TEXT NOT NULL
    );
  `);
  addAsset(db, { name: "Working", purchase: "2026-04-01", cost: 10 * LAKH });
  const idle = addAsset(db, {
    name: "Never commissioned",
    purchase: "2026-04-01",
    putToUse: null,
    cost: 10 * LAKH,
  });
  db.prepare(
    "UPDATE fixed_assets SET disposed_date = '2026-06-01', disposal_paise = ? WHERE id = ?"
  ).run(8 * LAKH, idle);

  const y1 = blockWdv(db, "2026-27", COMPUTERS);
  assert.equal(y1.additions_full_paise, 10 * LAKH); // only the working asset
  assert.equal(y1.disposals_paise, 0); // the idle one never entered the block
  assert.equal(y1.depreciation_paise, 4 * LAKH); // full 40% of ₹10,00,000
});

test("the schema refuses an impossible asset timeline", () => {
  const db = assetsDb();
  const insert = (purchase: string, putToUse: string | null) =>
    db
      .prepare(
        `INSERT INTO fixed_assets (name, block, cost_paise, purchase_date, put_to_use_date, created_at)
         VALUES ('X', 'computers', 100, ?, ?, 'now')`
      )
      .run(purchase, putToUse);
  assert.throws(() => insert("2026-04-01", "2026-03-01"), /CHECK/); // used before bought
  insert("2026-04-01", null);
  // Disposed before it was in use, and disposed while never in use.
  assert.throws(
    () =>
      db
        .prepare(
          `INSERT INTO fixed_assets (name, block, cost_paise, purchase_date, put_to_use_date, disposed_date, disposal_paise, created_at)
           VALUES ('Y', 'computers', 100, '2026-04-01', '2026-06-01', '2026-05-01', 50, 'now')`
        )
        .run(),
    /CHECK/
  );
  assert.throws(
    () =>
      db
        .prepare(
          `INSERT INTO fixed_assets (name, block, cost_paise, purchase_date, put_to_use_date, disposed_date, disposal_paise, created_at)
           VALUES ('Z', 'computers', 100, '2026-04-01', NULL, '2026-05-01', 50, 'now')`
        )
        .run(),
    /CHECK/
  );
});

// ---------------------------------------------------------------------------
// Schedule + posting guard
// ---------------------------------------------------------------------------

test("schedule spans every block and totals what the journal will post", () => {
  const db = assetsDb();
  addAsset(db, { purchase: "2026-04-01" }); // computers 40% → ₹40,000
  addAsset(db, { name: "Lathe", block: "plant", purchase: "2026-04-01" }); // 15% → ₹15,000

  const s = depreciationSchedule(db, "2026-27");
  assert.equal(s.blocks.length, IT_BLOCKS.length);
  assert.equal(s.total_depreciation_paise, 4_000_000 + 1_500_000);
  assert.equal(s.total_closing_paise, 6_000_000 + 8_500_000);
  assert.equal(blockWdv(db, "2026-27", PLANT).depreciation_paise, 1_500_000);
});

test("postedDepreciation finds the FY's entry and ignores other years", () => {
  const db = assetsDb();
  assert.equal(postedDepreciation(db, "2026-27"), undefined);

  const { journalId } = postManualVoucher(db, {
    kind: "journal",
    entry_type: "depreciation",
    entry_date: "2027-03-31",
    memo: "Depreciation for FY 2026-27",
    ref_no: "DEP-2026-27",
    legs: [
      { account_code: "5800", party_id: null, debit_paise: 5_500_000, credit_paise: 0 },
      { account_code: "1590", party_id: null, debit_paise: 0, credit_paise: 5_500_000 },
    ],
  });

  const found = postedDepreciation(db, "2026-27");
  assert.equal(found?.id, journalId);
  assert.equal(found?.entry_date, "2027-03-31");
  // The amount comes back so the page can spot a register that moved after
  // posting — books and schedule silently disagreeing is the failure mode.
  assert.equal(found?.amount_paise, 5_500_000);
  // 31 Mar 2027 belongs to FY 2026-27 only — the next year must still be open.
  assert.equal(postedDepreciation(db, "2027-28"), undefined);

  // The generated kind is stamped, not "journal", so the day book can name it.
  const row = db
    .prepare("SELECT entry_type FROM journals WHERE id = ?")
    .get(journalId) as { entry_type: string };
  assert.equal(row.entry_type, "depreciation");
  assert.equal(trialBalance(db).balanced, true);
});
