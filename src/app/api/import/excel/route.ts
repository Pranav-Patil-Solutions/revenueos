import { NextRequest, NextResponse } from "next/server";
import { createHash, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { getDb, UPLOADS_DIR } from "@/lib/db";
import { parseImportCsv, type ImportParty } from "@/lib/import-csv";
import { requireApiSession } from "@/lib/dal";

const MAX_BYTES = 2 * 1024 * 1024;

/** CSV template upload → document (source_type 'excel', status 'extracted')
 * + staged rows in ONE transaction, landing in the same review flow as a
 * photo extraction. */
export async function POST(req: NextRequest) {
  const gate = await requireApiSession();
  if (gate instanceof Response) return gate;
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json(
      { error: "Expected multipart form data with a file and party_id." },
      { status: 400 }
    );
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "file is required." }, { status: 400 });
  }
  const partyId = Number(form.get("party_id"));
  if (!Number.isInteger(partyId) || partyId <= 0) {
    return NextResponse.json(
      { error: "Pick a default party for rows that leave the party column blank." },
      { status: 400 }
    );
  }

  const db = getDb();
  const party = db.prepare("SELECT id FROM parties WHERE id = ?").get(partyId);
  if (!party) {
    return NextResponse.json({ error: "Party not found." }, { status: 404 });
  }

  const ext = (file.name ?? "").toLowerCase().split(".").pop() ?? "";
  if (ext === "xlsx" || ext === "xls") {
    return NextResponse.json(
      {
        error:
          "Save the sheet as CSV first (File → Save As → CSV) — the .xlsx binary isn't read directly.",
      },
      { status: 415 }
    );
  }
  if (ext !== "csv" && ext !== "txt") {
    return NextResponse.json(
      { error: "Upload the filled-in CSV template (.csv)." },
      { status: 415 }
    );
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      { error: "File is over the 2MB limit — split it into smaller batches." },
      { status: 413 }
    );
  }

  const buf = Buffer.from(await file.arrayBuffer());
  // Excel-on-Windows saves UTF-8 CSV with a BOM; strip it or the first
  // header cell reads as "\uFEFFdate".
  const text = buf.toString("utf8").replace(/^\uFEFF/, "");

  const parties = db
    .prepare("SELECT id, name FROM parties")
    .all() as ImportParty[];
  let parsed: ReturnType<typeof parseImportCsv>;
  try {
    parsed = parseImportCsv(text, parties);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Could not parse that file." },
      { status: 400 }
    );
  }

  const sha256 = createHash("sha256").update(buf).digest("hex");
  const duplicate = db
    .prepare("SELECT id FROM documents WHERE image_sha256 = ? ORDER BY id LIMIT 1")
    .get(sha256) as { id: number } | undefined;

  const filename = `${randomUUID()}.csv`;
  await writeFile(path.join(UPLOADS_DIR, filename), buf);

  const now = new Date().toISOString();
  const insertRow = db.prepare(
    `INSERT INTO staged_rows
       (document_id, row_no, entry_date, particulars, ref_no, debit_paise, credit_paise,
        entry_type, gst_rate, settle_account, confidence, is_balance_row, include, party_id)
     VALUES (@document_id, @row_no, @entry_date, @particulars, @ref_no, @debit_paise, @credit_paise,
             @entry_type, @gst_rate, @settle_account, @confidence, 0, @include, @party_id)`
  );
  const tx = db.transaction((): number => {
    const docId = db
      .prepare(
        `INSERT INTO documents
           (party_id, image_path, image_sha256, status, source_type, model, created_at, extracted_at)
         VALUES (?, ?, ?, 'extracted', 'excel', 'csv-template', ?, ?)`
      )
      .run(partyId, path.join("data", "uploads", filename), sha256, now, now)
      .lastInsertRowid as number;
    for (const r of parsed.rows) {
      insertRow.run({
        document_id: docId,
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
    return docId;
  });
  const docId = tx();

  return NextResponse.json({
    id: Number(docId),
    rows: parsed.rows.length,
    included: parsed.included,
    excluded: parsed.excluded,
    // Same bytes seen before — surfaced as a warning banner on the review screen.
    duplicate_of: duplicate?.id ?? null,
  });
}
