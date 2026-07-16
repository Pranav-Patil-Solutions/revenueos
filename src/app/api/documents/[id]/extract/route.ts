import { NextRequest, NextResponse } from "next/server";
import { extractDocument } from "@/lib/extraction";

/** Curl-able extraction trigger (also fired by the capture UI). */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const { rows } = await extractDocument(Number(id));
    return NextResponse.json({ status: "extracted", rows });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const status = /not found/i.test(message) ? 404 : 500;
    return NextResponse.json({ status: "failed", error: message }, { status });
  }
}
