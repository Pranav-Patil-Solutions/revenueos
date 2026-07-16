"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { unlink } from "node:fs/promises";
import path from "node:path";
import { getDb } from "./db";
import { extractDocument } from "./extraction";
import { applyDraftRows, postDocument } from "./posting";
import { GST_RATES } from "./tax/india-gst";
import type { DocumentRow, DraftRowInput, EntryType } from "./types";

const ENTRY_TYPES: EntryType[] = [
  "sale",
  "receipt",
  "purchase",
  "payment",
  "credit_note",
  "debit_note",
  "opening",
  "other",
];

function parseDraftRows(rowsJson: string): DraftRowInput[] {
  const parsed: unknown = JSON.parse(rowsJson);
  if (!Array.isArray(parsed)) throw new Error("rows payload must be an array");
  return parsed.map((raw, i) => {
    const r = raw as Record<string, unknown>;
    const label = `row ${i + 1}`;
    if (typeof r.id !== "number") throw new Error(`${label}: missing id`);
    const date =
      typeof r.entry_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(r.entry_date)
        ? r.entry_date
        : null;
    const money = (v: unknown, side: string): number | null => {
      if (v === null || v === undefined) return null;
      if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
        throw new Error(`${label}: ${side} must be a non-negative integer of paise`);
      }
      return v === 0 ? null : v;
    };
    const debit_paise = money(r.debit_paise, "debit");
    const credit_paise = money(r.credit_paise, "credit");
    if (debit_paise !== null && credit_paise !== null) {
      throw new Error(`${label}: has both debit and credit`);
    }
    if (!ENTRY_TYPES.includes(r.entry_type as EntryType)) {
      throw new Error(`${label}: unknown entry type`);
    }
    let gst_rate: number | null = null;
    if (r.gst_rate !== null && r.gst_rate !== undefined) {
      if (!GST_RATES.includes(r.gst_rate as (typeof GST_RATES)[number])) {
        throw new Error(`${label}: invalid GST rate`);
      }
      gst_rate = r.gst_rate as number;
    }
    return {
      id: r.id,
      entry_date: date,
      particulars: typeof r.particulars === "string" ? r.particulars : "",
      ref_no: typeof r.ref_no === "string" ? r.ref_no : "",
      debit_paise,
      credit_paise,
      entry_type: r.entry_type as EntryType,
      gst_rate,
      settle_account: r.settle_account === "bank" ? "bank" : "cash",
      include: r.include === true,
    };
  });
}

function saveDraft(docId: number, rows: DraftRowInput[]): void {
  const db = getDb();
  const doc = db
    .prepare("SELECT * FROM documents WHERE id = ?")
    .get(docId) as DocumentRow | undefined;
  if (!doc) throw new Error("Document not found.");
  if (doc.status === "posted") {
    throw new Error("Document is posted — its rows are locked.");
  }
  const tx = db.transaction(() => applyDraftRows(db, docId, rows));
  tx();
}

export async function createParty(formData: FormData): Promise<void> {
  const name = String(formData.get("name") ?? "").trim();
  const kind = String(formData.get("kind") ?? "");
  const gstin = String(formData.get("gstin") ?? "").trim().toUpperCase();
  const stateCode = String(formData.get("state_code") ?? "").trim();
  const phone = String(formData.get("phone") ?? "").trim();
  if (!name) throw new Error("Party name is required.");
  if (kind !== "customer" && kind !== "supplier") {
    throw new Error("Party kind must be customer or supplier.");
  }
  getDb()
    .prepare(
      `INSERT INTO parties (name, kind, gstin, state_code, phone, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(name, kind, gstin, stateCode, phone, new Date().toISOString());
  revalidatePath("/parties");
  redirect("/parties");
}

export async function updateSettings(formData: FormData): Promise<void> {
  const rate = Number(formData.get("default_gst_rate") ?? 18);
  getDb()
    .prepare(
      `UPDATE settings SET
         company_name = ?, gstin = ?, state_code = ?, country = ?,
         currency = ?, default_gst_rate = ?, tax_inclusive = ?
       WHERE id = 1`
    )
    .run(
      String(formData.get("company_name") ?? "").trim() || "My Company",
      String(formData.get("gstin") ?? "").trim().toUpperCase(),
      String(formData.get("state_code") ?? "").trim(),
      String(formData.get("country") ?? "IN").trim().toUpperCase() || "IN",
      String(formData.get("currency") ?? "INR").trim().toUpperCase() || "INR",
      Number.isFinite(rate) ? rate : 18,
      formData.get("tax_inclusive") === "on" ? 1 : 0
    );
  revalidatePath("/settings");
  redirect("/settings");
}

export async function runExtraction(docId: number): Promise<void> {
  try {
    await extractDocument(docId);
  } catch {
    // Failure state + message are already stored on the document row.
  }
  revalidatePath(`/documents/${docId}`);
  revalidatePath("/documents");
}

export async function saveDraftRows(
  docId: number,
  rowsJson: string
): Promise<void> {
  saveDraft(docId, parseDraftRows(rowsJson));
  revalidatePath(`/documents/${docId}`);
}

export async function saveAndPost(
  docId: number,
  rowsJson: string
): Promise<void> {
  postDocument(getDb(), docId, parseDraftRows(rowsJson));
  revalidatePath(`/documents/${docId}`);
  revalidatePath("/documents");
  revalidatePath("/");
}

export async function deleteDocument(docId: number): Promise<void> {
  const db = getDb();
  const doc = db
    .prepare("SELECT * FROM documents WHERE id = ?")
    .get(docId) as DocumentRow | undefined;
  if (!doc) throw new Error("Document not found.");
  if (doc.status === "posted") {
    throw new Error(
      "Posted documents cannot be deleted — the books reference them. Fix forward with an opposite entry."
    );
  }
  db.prepare("DELETE FROM documents WHERE id = ?").run(docId); // staged rows cascade
  await unlink(path.join(process.cwd(), doc.image_path)).catch(() => {});
  revalidatePath("/documents");
  redirect("/documents");
}
