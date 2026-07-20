import { NextRequest, NextResponse } from "next/server";
import { createHash, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { getDb, UPLOADS_DIR } from "@/lib/db";
import {
  parseDayBook,
  suggestTarget,
  unmappedLedgers,
  type LedgerMapping,
} from "@/lib/import-tally";

// Day books run larger than the CSV template — a full year of vouchers.
const MAX_BYTES = 8 * 1024 * 1024;

/**
 * Step 1 of the Tally import: parse the Day Book, park the file, and report
 * which ledgers still need a target. Nothing is written to the books here —
 * the staged rows are created in step 2 (createTallyImport) once the user has
 * mapped the ledgers.
 */
export async function POST(req: NextRequest) {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json(
      { error: "Expected multipart form data with a file." },
      { status: 400 }
    );
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "file is required." }, { status: 400 });
  }
  const ext = (file.name ?? "").toLowerCase().split(".").pop() ?? "";
  if (ext !== "xml") {
    return NextResponse.json(
      { error: "Export the Day Book as XML from Tally (Alt+E → XML) and upload the .xml." },
      { status: 415 }
    );
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      { error: "File is over the 8MB limit — export a shorter date range." },
      { status: 413 }
    );
  }

  const buf = Buffer.from(await file.arrayBuffer());
  // Tally on Windows writes UTF-8 with a BOM; it must not reach the XML parser.
  const xml = buf.toString("utf8").replace(/^\uFEFF/, "");

  let vouchers: ReturnType<typeof parseDayBook>;
  try {
    vouchers = parseDayBook(xml);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Could not read that file." },
      { status: 400 }
    );
  }

  const db = getDb();
  const mappings = db
    .prepare("SELECT * FROM ledger_mappings")
    .all() as LedgerMapping[];
  const parties = db
    .prepare("SELECT id, name FROM parties")
    .all() as { id: number; name: string }[];
  const accounts = db
    .prepare("SELECT id, name FROM accounts")
    .all() as { id: number; name: string }[];

  const unmapped = unmappedLedgers(vouchers, mappings).map((ledger_name) => ({
    ledger_name,
    suggestion: suggestTarget(ledger_name, parties, accounts),
  }));

  const sha256 = createHash("sha256").update(buf).digest("hex");
  const duplicate = db
    .prepare("SELECT id FROM documents WHERE image_sha256 = ? ORDER BY id LIMIT 1")
    .get(sha256) as { id: number } | undefined;

  // Parked under a UUID name; createTallyImport re-reads it by token so the
  // XML is parsed once more against the freshly saved mappings.
  const token = `${randomUUID()}.xml`;
  await writeFile(path.join(UPLOADS_DIR, token), buf);

  return NextResponse.json({
    token,
    vouchers: vouchers.length,
    unmapped,
    duplicate_of: duplicate?.id ?? null,
  });
}
