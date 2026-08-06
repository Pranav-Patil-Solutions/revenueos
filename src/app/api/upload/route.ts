import { NextRequest, NextResponse } from "next/server";
import { createHash, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { UPLOADS_DIR } from "@/lib/db";
import { requireApiBook } from "@/lib/dal";

const ALLOWED_EXT: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};
const MAX_BYTES = 15 * 1024 * 1024;

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
    return NextResponse.json({ error: "party_id is required." }, { status: 400 });
  }

  const party = book.get(
    "SELECT id FROM parties WHERE id = @partyId AND company_id = @company_id",
    { partyId }
  );
  if (!party) {
    return NextResponse.json({ error: "Party not found." }, { status: 404 });
  }

  const ext = (file.name ?? "").toLowerCase().split(".").pop() ?? "";
  const type = (file.type ?? "").toLowerCase();
  if (ext === "heic" || ext === "heif" || type.includes("heic") || type.includes("heif")) {
    return NextResponse.json(
      {
        error:
          "HEIC photos aren't supported. On iPhone, switch to the Most Compatible camera setting (Settings → Camera → Formats) and retake, or share as JPEG.",
      },
      { status: 415 }
    );
  }
  if (!ALLOWED_EXT[ext]) {
    return NextResponse.json(
      { error: "Unsupported file type — upload a JPG, PNG, or WEBP photo." },
      { status: 415 }
    );
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      { error: "Photo is over the 15MB limit — retake at a lower resolution." },
      { status: 413 }
    );
  }

  const buf = Buffer.from(await file.arrayBuffer());
  const sha256 = createHash("sha256").update(buf).digest("hex");
  const duplicate = book.get(
    `SELECT id FROM documents
     WHERE company_id = @company_id AND image_sha256 = @sha256
     ORDER BY id LIMIT 1`,
    { sha256 }
  ) as { id: number } | undefined;

  const filename = `${randomUUID()}.${ext}`;
  await writeFile(path.join(UPLOADS_DIR, filename), buf);

  const result = book.run(
    `INSERT INTO documents (party_id, image_path, image_sha256, status, created_at, company_id)
     VALUES (@partyId, @imagePath, @sha256, 'uploaded', @now, @company_id)`,
    {
      partyId,
      imagePath: path.join("data", "uploads", filename),
      sha256,
      now: new Date().toISOString(),
    }
  );

  return NextResponse.json({
    id: Number(result.lastInsertRowid),
    status: "uploaded",
    // Same bytes seen before — surfaced as a warning banner on the review screen.
    duplicate_of: duplicate?.id ?? null,
  });
}
