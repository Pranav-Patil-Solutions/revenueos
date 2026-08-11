import Database from "better-sqlite3";
import { book } from "../src/lib/book";
import { initSchema, seedCoreData } from "../src/lib/db";
import { migrate } from "../src/lib/migrate";
import { MIGRATIONS } from "../src/lib/migrations";
import { validateExtraction } from "../src/lib/extraction-schema";
import { DEMO_FIXTURE } from "../src/lib/extraction";
import { postDocument } from "../src/lib/posting";
import { defaultForHint } from "../src/lib/bank-accounts";
import type { DraftRowInput, SettleHint, StagedRow } from "../src/lib/types";

/** Fresh in-memory books with the demo fixture staged on document 1
 * (Sharma Traders, customer, intra-state). Migrated to schema-current, so
 * every scoped table already carries company_id and the existing book is
 * company 1 — the shape every other test helper and call site assumes. */
export function stagedDb(): Database.Database {
  const db = new Database(":memory:");
  initSchema(db);
  seedCoreData(db);
  migrate(db, MIGRATIONS, { now: "2026-01-01T00:00:00.000Z" });
  db.prepare(
    `INSERT INTO parties (name, kind, gstin, state_code, phone, created_at)
     VALUES ('Sharma Traders', 'customer', '27AAACS1234F1Z5', '27', '', '2026-07-01T00:00:00Z')`
  ).run();
  db.prepare(
    `INSERT INTO documents (party_id, image_path, image_sha256, status, created_at)
     VALUES (1, 'data/uploads/demo.jpg', 'demo-sha', 'extracted', '2026-07-16T00:00:00Z')`
  ).run();
  // Migration 004 wrapped the seeded Cash/Bank ledgers in bank_accounts, so the
  // fixture's cash/bank HINTS resolve through the same path the real ingestion
  // paths use rather than through hardcoded ids.
  const b = book(db, 1);
  const accountFor = (hint: SettleHint): number => defaultForHint(b, hint).id;
  const insert = db.prepare(
    `INSERT INTO staged_rows
       (document_id, row_no, entry_date, particulars, ref_no, debit_paise, credit_paise,
        entry_type, gst_rate, bank_account_id, confidence, is_balance_row, include)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const r of validateExtraction(DEMO_FIXTURE).rows) {
    insert.run(
      r.row_no, r.entry_date, r.particulars, r.ref_no, r.debit_paise, r.credit_paise,
      r.entry_type, r.gst_rate, accountFor(r.settle_hint), r.confidence,
      r.is_balance_row ? 1 : 0, r.include ? 1 : 0
    );
  }
  return db;
}

/**
 * The id of a company's default cash or bank account (RVOS-006 P0a).
 *
 * Resolved rather than hardcoded: ids depend on how many companies migration
 * 004 wrapped and in what order, so a literal `2` here would be a test that
 * passes for the wrong reason the moment a fixture adds a company.
 */
export function settleId(
  db: Database.Database,
  companyId: number,
  hint: SettleHint
): number {
  return defaultForHint(book(db, companyId), hint).id;
}

/** Review-grid payload mirroring the staged rows, with extra exclusions. */
export function draftRows(
  db: Database.Database,
  excludeRowNos: number[] = []
): DraftRowInput[] {
  const staged = db
    .prepare("SELECT * FROM staged_rows WHERE document_id = 1 ORDER BY row_no")
    .all() as StagedRow[];
  return staged.map((r) => ({
    id: r.id,
    entry_date: r.entry_date,
    particulars: r.particulars,
    ref_no: r.ref_no,
    debit_paise: r.debit_paise,
    credit_paise: r.credit_paise,
    entry_type: r.entry_type,
    gst_rate: r.gst_rate,
    bank_account_id: r.bank_account_id,
    include: excludeRowNos.includes(r.row_no) ? false : r.include === 1,
  }));
}

/** Books with the demo fixture fully posted (row 10 excluded at review). */
export function postedDb(): Database.Database {
  const db = stagedDb();
  postDocument(book(db, 1), 1, draftRows(db, [10]));
  return db;
}
