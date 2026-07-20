import { strict as assert } from "node:assert";
import { test } from "node:test";
import Database from "better-sqlite3";
import { initSchema, seedCoreData } from "../src/lib/db";
import { rupeeStringToPaise } from "../src/lib/format";
import {
  parseCsv,
  parseImportCsv,
  TEMPLATE_HEADERS,
  type ImportParty,
} from "../src/lib/import-csv";
import { postDocument } from "../src/lib/posting";
import type { DraftRowInput, StagedRow } from "../src/lib/types";

const HEADER = TEMPLATE_HEADERS.join(",");
const PARTIES: ImportParty[] = [
  { id: 1, name: "Sharma Traders" },
  { id: 2, name: "Gupta Suppliers" },
];

// ---------------------------------------------------------------------------
// rupeeStringToPaise — the exact-string money path for file data
// ---------------------------------------------------------------------------

test("rupeeStringToPaise: Indian grouping, symbols, and edges — exact", () => {
  assert.equal(rupeeStringToPaise("1,23,456.78"), 12_345_678);
  assert.equal(rupeeStringToPaise("₹ 11,800"), 1_180_000);
  assert.equal(rupeeStringToPaise("5900"), 590_000);
  assert.equal(rupeeStringToPaise("500.5"), 50_050); // one decimal = 50 paise
  assert.equal(rupeeStringToPaise("0.05"), 5);
  assert.equal(rupeeStringToPaise("0"), 0);
  assert.equal(rupeeStringToPaise("-250.75"), -25_075);
  // The float trap this function exists to avoid: 4111.11 * 100 = 411111.00000000006
  assert.equal(rupeeStringToPaise("4,111.11"), 411_111);
});

test("rupeeStringToPaise: rejects >2 decimals, floats junk, and non-amounts", () => {
  assert.throws(() => rupeeStringToPaise("12.345"), /more than 2 decimal/);
  assert.throws(() => rupeeStringToPaise("1.2e3"), /not a rupee amount/);
  assert.throws(() => rupeeStringToPaise("abc"), /not a rupee amount/);
  assert.throws(() => rupeeStringToPaise(""), /not a rupee amount/);
  assert.throws(() => rupeeStringToPaise("12."), /not a rupee amount/);
  assert.throws(() => rupeeStringToPaise("--5"), /not a rupee amount/);
});

// ---------------------------------------------------------------------------
// parseCsv — RFC-4180
// ---------------------------------------------------------------------------

test("parseCsv: quoted commas, escaped quotes, embedded newlines, CRLF", () => {
  const text = 'a,"b,1","say ""hi""","line1\nline2"\r\nc,d,e,f\r\n';
  const rows = parseCsv(text);
  assert.deepEqual(rows, [
    ["a", "b,1", 'say "hi"', "line1\nline2"],
    ["c", "d", "e", "f"],
  ]);
});

test("parseCsv: blank records and trailing newlines are dropped", () => {
  const rows = parseCsv("a,b\n\n,,\nc,d\n\n");
  assert.deepEqual(rows, [
    ["a", "b"],
    ["c", "d"],
  ]);
});

// ---------------------------------------------------------------------------
// parseImportCsv — template semantics
// ---------------------------------------------------------------------------

test("header must match the template exactly (file-level reject)", () => {
  assert.throws(
    () => parseImportCsv("date,amount\n2026-07-01,5", PARTIES),
    /Header row must be exactly/
  );
  assert.throws(() => parseImportCsv("", PARTIES), /empty/);
  assert.throws(() => parseImportCsv(HEADER + "\n", PARTIES), /No data rows/);
});

test("clean rows: Indian amounts, party match is case-insensitive, dd/mm/yyyy ok", () => {
  const { rows, included, excluded } = parseImportCsv(
    HEADER +
      '\n02/07/2026,"Cloth bill, big","241",sharma traders,sale,"1,23,456.78",,18,cash' +
      "\n2026-07-14,Packing inv 88,88,Gupta Suppliers,purchase,,5900,,bank",
    PARTIES
  );
  assert.equal(included, 2);
  assert.equal(excluded, 0);
  assert.deepEqual(
    rows.map((r) => ({
      d: r.entry_date,
      p: r.party_id,
      dr: r.debit_paise,
      cr: r.credit_paise,
      via: r.settle_account,
    })),
    [
      { d: "2026-07-02", p: 1, dr: 12_345_678, cr: null, via: "cash" },
      { d: "2026-07-14", p: 2, dr: null, cr: 590_000, via: "bank" },
    ]
  );
  assert.equal(rows[0].particulars, "Cloth bill, big"); // no suffix on clean rows
  assert.equal(rows[0].confidence, 1);
});

test("blank party = NULL (doc fallback); unknown party excludes the row with a reason", () => {
  const { rows } = parseImportCsv(
    HEADER +
      "\n2026-07-01,Cash sale,,,receipt,,500,,cash" +
      "\n2026-07-02,Mystery,,Nobody & Co,sale,100,,,cash",
    PARTIES
  );
  assert.equal(rows[0].party_id, null);
  assert.equal(rows[0].include, true);
  assert.equal(rows[1].include, false);
  assert.match(rows[1].reason, /unknown party "Nobody & Co"/);
  assert.match(rows[1].particulars, /⚠.*unknown party/); // review table surfaces it
  assert.ok(rows[1].confidence < 0.4); // red-flagged in the grid
});

test("duplicate party names never resolve silently — the row is excluded as ambiguous", () => {
  // parties.name has no UNIQUE constraint; a collision must not last-write-win.
  const dupes: ImportParty[] = [
    { id: 1, name: "Sharma Traders" },
    { id: 2, name: "sharma traders" }, // same name, different case
  ];
  const { rows } = parseImportCsv(
    HEADER + "\n2026-07-01,Sale,,Sharma Traders,sale,100,,,cash",
    dupes
  );
  assert.equal(rows[0].include, false);
  assert.equal(rows[0].party_id, null);
  assert.match(rows[0].reason, /matches more than one party/);
});

test("entry_type whitelist: normalized, unknown values fall to excluded 'other'", () => {
  const { rows } = parseImportCsv(
    HEADER +
      "\n2026-07-01,CN,,Sharma Traders,Credit Note,,118,,cash" + // space → underscore
      "\n2026-07-02,Journal-ish,,,journal,50,,,cash" + // not in the frozen 8
      "\n2026-07-03,Unknown,,,other,50,,,cash" + // unpostable by definition
      "\n2026-07-04,Missing,,,,50,,,cash",
    PARTIES
  );
  assert.equal(rows[0].entry_type, "credit_note");
  assert.equal(rows[0].include, true);
  assert.equal(rows[1].entry_type, "other"); // safe fallback inside the CHECK
  assert.equal(rows[1].include, false);
  assert.match(rows[1].reason, /unknown entry_type "journal"/);
  assert.equal(rows[2].include, false);
  assert.match(rows[2].reason, /unpostable/);
  assert.equal(rows[3].include, false);
  assert.match(rows[3].reason, /entry_type is required/);
});

test("amount rules: exactly one side, no negatives, no 3-decimal floats, bad GST/settle", () => {
  const { rows, included, excluded } = parseImportCsv(
    HEADER +
      "\n2026-07-01,Both,,,sale,100,200,,cash" +
      "\n2026-07-02,Neither,,,sale,,,,cash" +
      "\n2026-07-03,Precise,,,sale,12.345,,,cash" +
      "\n2026-07-04,Negative,,,sale,-100,,,cash" +
      "\n2026-07-05,BadRate,,,sale,100,,15,cash" +
      "\n2026-07-06,BadVia,,,sale,100,,,upi",
    PARTIES
  );
  assert.equal(included, 0);
  assert.equal(excluded, 6);
  assert.match(rows[0].reason, /both debit and credit/);
  assert.match(rows[1].reason, /needs an amount/);
  assert.match(rows[2].reason, /more than 2 decimal/);
  assert.match(rows[3].reason, /must not be negative/);
  assert.match(rows[4].reason, /GST rate/);
  assert.match(rows[5].reason, /cash or bank/);
});

test("bad date excludes; blank date stays included for review to fill", () => {
  const { rows } = parseImportCsv(
    HEADER +
      "\n31/31/2026,BadDate,,,sale,100,,,cash" +
      "\n,NoDate,,,sale,100,,,cash",
    PARTIES
  );
  assert.equal(rows[0].include, false);
  assert.match(rows[0].reason, /not a real date/);
  assert.equal(rows[1].include, true);
  assert.equal(rows[1].entry_date, null);
});

// ---------------------------------------------------------------------------
// Against a real db created from the ORIGINAL DDL — the frozen staged_rows
// CHECK must accept every entry_type the parser can emit (regression net for
// the widening-no-ops-on-live-DBs trap).
// ---------------------------------------------------------------------------

function importDb(): Database.Database {
  const db = new Database(":memory:");
  initSchema(db);
  seedCoreData(db);
  db.prepare(
    `INSERT INTO parties (name, kind, gstin, state_code, phone, created_at)
     VALUES ('Sharma Traders', 'customer', '', '27', '', '2026-07-01T00:00:00Z'),
            ('Gupta Suppliers', 'supplier', '', '07', '', '2026-07-01T00:00:00Z')`
  ).run();
  return db;
}

test("end-to-end: parse → stage (frozen CHECK holds) → post → TB zero, both parties booked", () => {
  const db = importDb();
  const csv =
    HEADER +
    '\n2026-07-02,"Cloth bill #241",241,,sale,"11,800.00",,18,cash' + // NULL party → doc's Sharma
    "\n2026-07-14,Packing inv 88,88,Gupta Suppliers,purchase,,5900,18,bank" +
    "\n2026-07-20,Broken row,,Nobody & Co,journal,1.234,,,upi"; // every problem at once
  const parsed = parseImportCsv(csv, PARTIES);
  assert.equal(parsed.included, 2);
  assert.equal(parsed.excluded, 1);

  db.prepare(
    `INSERT INTO documents (party_id, image_path, image_sha256, status, source_type, model, created_at, extracted_at)
     VALUES (1, 'data/uploads/import.csv', 'csv-sha', 'extracted', 'excel', 'csv-template', '2026-07-16T00:00:00Z', '2026-07-16T00:00:00Z')`
  ).run();
  const insert = db.prepare(
    `INSERT INTO staged_rows
       (document_id, row_no, entry_date, particulars, ref_no, debit_paise, credit_paise,
        entry_type, gst_rate, settle_account, confidence, is_balance_row, include, party_id)
     VALUES (1, @row_no, @entry_date, @particulars, @ref_no, @debit_paise, @credit_paise,
             @entry_type, @gst_rate, @settle_account, @confidence, 0, @include, @party_id)`
  );
  // Every parsed row inserts — including the broken one mapped to 'other' —
  // proving nothing the parser emits violates the frozen 8-value CHECK.
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
  assert.equal(journals, 2);

  const sum = db
    .prepare("SELECT SUM(debit_paise) - SUM(credit_paise) AS d FROM journal_lines")
    .get() as { d: number };
  assert.equal(sum.d, 0);

  const bal = (code: string, partyId: number) =>
    (
      db
        .prepare(
          `SELECT COALESCE(SUM(jl.debit_paise) - SUM(jl.credit_paise), 0) AS b
           FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
           WHERE a.code = ? AND jl.party_id = ?`
        )
        .get(code, partyId) as { b: number }
    ).b;
  assert.equal(bal("1200", 1), 1_180_000); // AR Sharma (doc fallback)
  assert.equal(bal("2100", 2), -590_000); // AP Gupta (per-row party), credit-heavy
  assert.equal(bal("2100", 1), 0); // nothing leaked onto the doc party's AP
});
