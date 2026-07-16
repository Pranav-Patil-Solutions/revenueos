import { NextRequest } from "next/server";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { getDb } from "@/lib/db";

const TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const doc = getDb()
    .prepare("SELECT image_path FROM documents WHERE id = ?")
    .get(Number(id)) as { image_path: string } | undefined;
  if (!doc) return new Response("Not found", { status: 404 });

  let buf: Buffer;
  try {
    buf = await readFile(path.join(process.cwd(), doc.image_path));
  } catch {
    return new Response("Image file missing on disk", { status: 404 });
  }
  const ext = doc.image_path.toLowerCase().split(".").pop() ?? "";
  return new Response(new Uint8Array(buf), {
    headers: {
      "Content-Type": TYPES[ext] ?? "application/octet-stream",
      "Cache-Control": "no-store",
    },
  });
}
