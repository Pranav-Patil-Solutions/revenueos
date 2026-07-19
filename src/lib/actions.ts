"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { unlink } from "node:fs/promises";
import path from "node:path";
import { groupFor } from "./coa";
import { getDb } from "./db";
import { extractDocument } from "./extraction";
import { applyDraftRows, postDocument } from "./posting";
import { GST_RATES } from "./tax/india-gst";
import type {
  AccountType,
  DocumentRow,
  DraftRowInput,
  EntryType,
  EntityType,
  ItRegime,
  Presumptive,
} from "./types";

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

const ENTITY_TYPES: EntityType[] = ["proprietorship", "partnership", "company"];
const IT_REGIMES: ItRegime[] = ["old", "new"];
const PRESUMPTIVE: Presumptive[] = ["", "44AD", "44ADA"];

export async function updateSettings(formData: FormData): Promise<void> {
  const rate = Number(formData.get("default_gst_rate") ?? 18);
  const entityType = String(formData.get("entity_type") ?? "proprietorship");
  if (!ENTITY_TYPES.includes(entityType as EntityType)) {
    throw new Error("Unknown entity type.");
  }
  const itRegime = String(formData.get("it_regime") ?? "new");
  if (!IT_REGIMES.includes(itRegime as ItRegime)) {
    throw new Error("IT regime must be old or new.");
  }
  const presumptive = String(formData.get("presumptive") ?? "");
  if (!PRESUMPTIVE.includes(presumptive as Presumptive)) {
    throw new Error("Presumptive scheme must be blank, 44AD, or 44ADA.");
  }
  const lockedThrough = String(formData.get("books_locked_through") ?? "").trim();
  if (lockedThrough !== "" && !/^\d{4}-\d{2}-\d{2}$/.test(lockedThrough)) {
    throw new Error("Books-locked-through must be a date (YYYY-MM-DD) or blank.");
  }
  getDb()
    .prepare(
      `UPDATE settings SET
         company_name = ?, gstin = ?, state_code = ?, country = ?,
         currency = ?, default_gst_rate = ?, tax_inclusive = ?,
         entity_type = ?, pan = ?, tan = ?, it_regime = ?, presumptive = ?,
         books_locked_through = ?, fy_audit_case = ?
       WHERE id = 1`
    )
    .run(
      String(formData.get("company_name") ?? "").trim() || "My Company",
      String(formData.get("gstin") ?? "").trim().toUpperCase(),
      String(formData.get("state_code") ?? "").trim(),
      String(formData.get("country") ?? "IN").trim().toUpperCase() || "IN",
      String(formData.get("currency") ?? "INR").trim().toUpperCase() || "INR",
      Number.isFinite(rate) ? rate : 18,
      formData.get("tax_inclusive") === "on" ? 1 : 0,
      entityType,
      String(formData.get("pan") ?? "").trim().toUpperCase(),
      String(formData.get("tan") ?? "").trim().toUpperCase(),
      itRegime,
      presumptive,
      lockedThrough,
      formData.get("fy_audit_case") === "on" ? 1 : 0
    );
  revalidatePath("/settings");
  redirect("/settings");
}

const ACCOUNT_TYPES: AccountType[] = [
  "asset",
  "liability",
  "equity",
  "income",
  "expense",
];

/** COA is add-only/rename-only — accounts are never deleted or retyped, the
 * books may already reference them. */
export async function createAccount(formData: FormData): Promise<void> {
  const code = String(formData.get("code") ?? "").trim();
  const name = String(formData.get("name") ?? "").trim();
  const type = String(formData.get("type") ?? "");
  const groupCode = String(formData.get("group_code") ?? "");
  if (!/^\d{4}$/.test(code)) {
    throw new Error("Account code must be 4 digits (e.g. 5910).");
  }
  if (!name) throw new Error("Account name is required.");
  if (!ACCOUNT_TYPES.includes(type as AccountType)) {
    throw new Error("Unknown account type.");
  }
  if (!groupFor(groupCode)) throw new Error("Unknown account group.");
  const db = getDb();
  const existing = db
    .prepare("SELECT id FROM accounts WHERE code = ?")
    .get(code);
  if (existing) throw new Error(`Account code ${code} already exists.`);
  db.prepare(
    "INSERT INTO accounts (code, name, type, group_code) VALUES (?, ?, ?, ?)"
  ).run(code, name, type, groupCode);
  revalidatePath("/settings/accounts");
  redirect("/settings/accounts");
}

export async function renameAccount(formData: FormData): Promise<void> {
  const id = Number(formData.get("id"));
  const name = String(formData.get("name") ?? "").trim();
  if (!Number.isInteger(id) || id <= 0) throw new Error("Bad account id.");
  if (!name) throw new Error("Account name is required.");
  getDb().prepare("UPDATE accounts SET name = ? WHERE id = ?").run(name, id);
  revalidatePath("/settings/accounts");
  redirect("/settings/accounts");
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
