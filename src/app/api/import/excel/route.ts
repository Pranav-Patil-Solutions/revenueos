import { NextRequest, NextResponse } from "next/server";
import { createHash, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { UPLOADS_DIR } from "@/lib/db";
import { parseImportCsv, stageExcelImport, type ImportParty } from "@/lib/import-csv";
import { requireApiBook } from "@/lib/dal";

const MAX_BYTES = 2 * 1024 * 1024;

/** CSV template upload → document (source_type 'excel', status 'extracted')
 * + staged rows in ONE transaction, landing in the same review flow as a
 * photo extraction — in the ACTIVE company only (RVOS-004 P4). */
export async function POST(req: NextRequest) {
  const gate = await requireApiBook();
  if (gate instanceof Response) return gate;
  const { book } = gate;
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

  const party = book.get(
    "SELECT id FROM parties WHERE id = @id AND company_id = @company_id",
    { id: partyId }
  );
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

  const parties = book.all<ImportParty>(
    "SELECT id, name FROM parties WHERE company_id = @company_id"
  );
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
  const duplicate = book.get<{ id: number }>(
    "SELECT id FROM documents WHERE image_sha256 = @sha AND company_id = @company_id ORDER BY id LIMIT 1",
    { sha: sha256 }
  );

  const filename = `${randomUUID()}.csv`;
  await writeFile(path.join(UPLOADS_DIR, filename), buf);

  const now = new Date().toISOString();
  const docId = stageExcelImport(book, {
    partyId,
    rows: parsed.rows,
    imagePath: path.join("data", "uploads", filename),
    sha256,
    now,
  });

  return NextResponse.json({
    id: Number(docId),
    rows: parsed.rows.length,
    included: parsed.included,
    excluded: parsed.excluded,
    // Same bytes seen before — surfaced as a warning banner on the review screen.
    duplicate_of: duplicate?.id ?? null,
  });
}
