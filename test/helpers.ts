import Database from "better-sqlite3";
import { initSchema, seedCoreData } from "../src/lib/db";
import { validateExtraction } from "../src/lib/extraction-schema";
import { DEMO_FIXTURE } from "../src/lib/extraction";
import { postDocument } from "../src/lib/posting";
import type { DraftRowInput, StagedRow } from "../src/lib/types";

/** Fresh in-memory books with the demo fixture staged on document 1
 * (Sharma Traders, customer, intra-state). */
export function stagedDb(): Database.Database {
  const db = new Database(":memory:");
  initSchema(db);
  seedCoreData(db);
  db.prepare(
    `INSERT INTO parties (name, kind, gstin, state_code, phone, created_at)
     VALUES ('Sharma Traders', 'customer', '27AAACS1234F1Z5', '27', '', '2026-07-01T00:00:00Z')`
  ).run();
  db.prepare(
    `INSERT INTO documents (party_id, image_path, image_sha256, status, created_at)
     VALUES (1, 'data/uploads/demo.jpg', 'demo-sha', 'extracted', '2026-07-16T00:00:00Z')`
  ).run();
  const insert = db.prepare(
    `INSERT INTO staged_rows
       (document_id, row_no, entry_date, particulars, ref_no, debit_paise, credit_paise,
        entry_type, gst_rate, settle_account, confidence, is_balance_row, include)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const r of validateExtraction(DEMO_FIXTURE).rows) {
    insert.run(
      r.row_no, r.entry_date, r.particulars, r.ref_no, r.debit_paise, r.credit_paise,
      r.entry_type, r.gst_rate, r.settle_account, r.confidence,
      r.is_balance_row ? 1 : 0, r.include ? 1 : 0
    );
  }
  return db;
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
    settle_account: r.settle_account,
    include: excludeRowNos.includes(r.row_no) ? false : r.include === 1,
  }));
}

/** Books with the demo fixture fully posted (row 10 excluded at review). */
export function postedDb(): Database.Database {
  const db = stagedDb();
  postDocument(db, 1, draftRows(db, [10]));
  return db;
}
