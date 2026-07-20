"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createHash } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { groupFor } from "./coa";
import { getDb, UPLOADS_DIR } from "./db";
import { extractDocument } from "./extraction";
import {
  parseDayBook,
  tallyVouchersToRows,
  type LedgerMapping,
  type MappedAccount,
} from "./import-tally";
import { applyDraftRows, postDocument } from "./posting";
import { GST_RATES } from "./tax/india-gst";
import {
  postManualVoucher,
  type JournalLegInput,
  type StructuredKind,
  type VoucherInput,
} from "./vouchers";
import type {
  AccountType,
  DocumentRow,
  DraftRowInput,
  EntryType,
  EntityType,
  ItRegime,
  PartyKind,
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

const STRUCTURED_KINDS: StructuredKind[] = [
  "sale",
  "purchase",
  "receipt",
  "payment",
  "credit_note",
  "debit_note",
];

function parseVoucherLegs(legsJson: string): JournalLegInput[] {
  const parsed: unknown = JSON.parse(legsJson);
  if (!Array.isArray(parsed)) throw new Error("legs payload must be an array");
  return parsed.map((raw, i) => {
    const l = raw as Record<string, unknown>;
    const label = `leg ${i + 1}`;
    if (typeof l.account_code !== "string") {
      throw new Error(`${label}: missing account`);
    }
    const money = (v: unknown, side: string): number => {
      if (v === null || v === undefined) return 0;
      if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
        throw new Error(`${label}: ${side} must be a non-negative integer of paise`);
      }
      return v;
    };
    return {
      account_code: l.account_code,
      party_id: typeof l.party_id === "number" ? l.party_id : null,
      debit_paise: money(l.debit_paise, "debit"),
      credit_paise: money(l.credit_paise, "credit"),
    };
  });
}

/** Manual voucher entry — parses the form by kind, posts one journal. */
export async function createVoucher(formData: FormData): Promise<void> {
  const kind = String(formData.get("kind") ?? "");
  const entry_date = String(formData.get("entry_date") ?? "").trim();
  const memo = String(formData.get("memo") ?? "").trim();
  const ref_no = String(formData.get("ref_no") ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(entry_date)) {
    throw new Error("Voucher date is required (YYYY-MM-DD).");
  }

  const amount = (): number => {
    const v = Number(formData.get("amount_paise"));
    if (!Number.isInteger(v) || v <= 0) {
      throw new Error("Amount must be a positive amount in paise.");
    }
    return v;
  };

  let input: VoucherInput;
  if (kind === "contra") {
    const from = formData.get("from") === "bank" ? "bank" : "cash";
    const to = formData.get("to") === "bank" ? "bank" : "cash";
    input = { kind, entry_date, memo, ref_no, from, to, amount_paise: amount() };
  } else if (kind === "journal") {
    input = {
      kind,
      entry_date,
      memo,
      ref_no,
      legs: parseVoucherLegs(String(formData.get("legs") ?? "[]")),
    };
  } else if (STRUCTURED_KINDS.includes(kind as StructuredKind)) {
    const party_id = Number(formData.get("party_id"));
    if (!Number.isInteger(party_id) || party_id <= 0) {
      throw new Error("Pick a party for this voucher.");
    }
    let gst_rate: number | null = null;
    const rateRaw = String(formData.get("gst_rate") ?? "");
    if (rateRaw !== "") {
      const rate = Number(rateRaw);
      if (!GST_RATES.includes(rate as (typeof GST_RATES)[number])) {
        throw new Error("Invalid GST rate.");
      }
      gst_rate = rate;
    }
    input = {
      kind: kind as StructuredKind,
      entry_date,
      memo,
      ref_no,
      party_id,
      amount_paise: amount(),
      gst_rate,
      settle_account: formData.get("settle_account") === "bank" ? "bank" : "cash",
    };
  } else {
    throw new Error("Unknown voucher kind.");
  }

  const { journalId } = postManualVoucher(getDb(), input);
  revalidatePath("/vouchers");
  revalidatePath("/reports");
  revalidatePath("/");
  redirect(`/vouchers?kind=${kind}&posted=${journalId}`);
}

/** Alt+C inline party create from the voucher form — returns the new row so
 * the form can select it without losing state (no redirect). */
export async function createVoucherParty(
  name: string,
  kind: PartyKind
): Promise<{ id: number; name: string }> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Party name is required.");
  if (kind !== "customer" && kind !== "supplier") {
    throw new Error("Party kind must be customer or supplier.");
  }
  const id = getDb()
    .prepare(
      `INSERT INTO parties (name, kind, gstin, state_code, phone, created_at)
       VALUES (?, ?, '', '', '', ?)`
    )
    .run(trimmed, kind, new Date().toISOString()).lastInsertRowid as number;
  revalidatePath("/parties");
  return { id: Number(id), name: trimmed };
}

/** Step 2 of the Tally import: persist the ledger mappings the user just
 * chose, re-read the parked Day Book against them, and stage every voucher —
 * mappings, document and rows in ONE transaction, so a failure anywhere
 * leaves neither half-saved mappings nor an orphan document. */
export async function createTallyImport(formData: FormData): Promise<void> {
  const token = String(formData.get("token") ?? "");
  // The token names a file we wrote; anything but the UUID we minted (and so
  // any traversal attempt) is refused before it reaches the filesystem.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.xml$/.test(token)) {
    throw new Error("That upload has expired — pick the Day Book file again.");
  }
  const partyId = Number(formData.get("party_id"));
  if (!Number.isInteger(partyId) || partyId <= 0) {
    throw new Error("Pick a default party for vouchers without one.");
  }

  const db = getDb();
  if (!db.prepare("SELECT id FROM parties WHERE id = ?").get(partyId)) {
    throw new Error("Party not found.");
  }
  const partyIds = new Set(
    (db.prepare("SELECT id FROM parties").all() as { id: number }[]).map((p) => p.id)
  );
  const accountIds = new Set(
    (db.prepare("SELECT id FROM accounts").all() as { id: number }[]).map((a) => a.id)
  );

  // "map:<ledger name>" → "party:<id>" | "account:<id>".
  const chosen: LedgerMapping[] = [];
  for (const [key, value] of formData.entries()) {
    if (!key.startsWith("map:")) continue;
    const ledger_name = key.slice(4);
    const raw = String(value);
    if (raw === "") throw new Error(`Pick a target for the ledger "${ledger_name}".`);
    const [kind, idRaw] = raw.split(":");
    const id = Number(idRaw);
    if (!Number.isInteger(id) || id <= 0) {
      throw new Error(`Bad target for the ledger "${ledger_name}".`);
    }
    if (kind === "party") {
      if (!partyIds.has(id)) throw new Error(`Party for "${ledger_name}" no longer exists.`);
      chosen.push({ ledger_name, target_kind: "party", account_id: null, party_id: id });
    } else if (kind === "account") {
      if (!accountIds.has(id)) throw new Error(`Account for "${ledger_name}" no longer exists.`);
      chosen.push({ ledger_name, target_kind: "account", account_id: id, party_id: null });
    } else {
      throw new Error(`Bad target for the ledger "${ledger_name}".`);
    }
  }

  const filePath = path.join(UPLOADS_DIR, token);
  const buf = await readFile(filePath).catch(() => {
    throw new Error("That upload has expired — pick the Day Book file again.");
  });
  const vouchers = parseDayBook(buf.toString("utf8").replace(/^\uFEFF/, ""));
  const sha256 = createHash("sha256").update(buf).digest("hex");
  const now = new Date().toISOString();

  const upsertMapping = db.prepare(
    `INSERT INTO ledger_mappings (ledger_name, target_kind, account_id, party_id, created_at)
     VALUES (@ledger_name, @target_kind, @account_id, @party_id, @created_at)
     ON CONFLICT(ledger_name) DO UPDATE SET
       target_kind = excluded.target_kind,
       account_id  = excluded.account_id,
       party_id    = excluded.party_id`
  );
  const insertRow = db.prepare(
    `INSERT INTO staged_rows
       (document_id, row_no, entry_date, particulars, ref_no, debit_paise, credit_paise,
        entry_type, gst_rate, settle_account, confidence, is_balance_row, include, party_id)
     VALUES (@document_id, @row_no, @entry_date, @particulars, @ref_no, @debit_paise, @credit_paise,
             @entry_type, @gst_rate, @settle_account, @confidence, 0, @include, @party_id)`
  );

  const docId = db.transaction((): number => {
    for (const m of chosen) upsertMapping.run({ ...m, created_at: now });
    // Re-read AFTER the upsert so previously-saved mappings and the ones just
    // chosen are both in play.
    const mappings = db
      .prepare("SELECT * FROM ledger_mappings")
      .all() as LedgerMapping[];
    const accounts = db
      .prepare("SELECT id, code, type FROM accounts")
      .all() as MappedAccount[];
    const settings = db
      .prepare("SELECT tax_inclusive FROM settings WHERE id = 1")
      .get() as { tax_inclusive: number };
    const parsed = tallyVouchersToRows(vouchers, mappings, accounts, {
      taxInclusive: settings.tax_inclusive === 1,
    });

    const id = db
      .prepare(
        `INSERT INTO documents
           (party_id, image_path, image_sha256, status, source_type, model, created_at, extracted_at)
         VALUES (?, ?, ?, 'extracted', 'tally', 'tally-daybook', ?, ?)`
      )
      .run(partyId, path.join("data", "uploads", token), sha256, now, now)
      .lastInsertRowid as number;
    for (const r of parsed.rows) {
      insertRow.run({
        document_id: id,
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
    return id;
  })();

  revalidatePath("/documents");
  revalidatePath("/imports");
  redirect(`/documents/${docId}`);
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
