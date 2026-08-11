"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createHash } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { setSessionCompany } from "./auth";
import type { Book } from "./book";
import { groupFor } from "./coa";
import {
  archiveCompany,
  createCompany,
  getCompany,
  renameCompany,
  updateCompanySettings,
} from "./companies";
import { generateItems } from "./compliance";
import { requireBook, requireSession } from "./dal";
import {
  archiveBankAccount,
  createBankAccount,
  renameBankAccount,
  setDefaultBankAccount,
} from "./bank-accounts";
import { getDb, seedAccountsForCompany, UPLOADS_DIR } from "./db";
import { readSessionToken } from "./session";
import { extractDocument } from "./extraction";
import { rupeeStringToPaise, todayIso } from "./format";
import { fyEnd, fyLabel, fyList, fyStart } from "./fy";
import {
  blockFor,
  depreciationSchedule,
  postedDepreciation,
} from "./tax/depreciation";
import {
  finalizeTallyImport,
  parseDayBook,
  type LedgerMapping,
} from "./import-tally";
import { applyDraftRows, postDocument } from "./posting";
import { GST_RATES } from "./tax/india-gst";
import { tdsSection } from "./tax/tds";
import {
  postManualVoucher,
  postVoucherWithTds,
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
  FixedAssetRow,
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

/** A bank/cash account id off a review-grid payload. Untrusted input, so it is
 * validated as a positive integer here and its OWNERSHIP is checked by the Book
 * handle when the posting path resolves it to a ledger code (RVOS-006 P0a). */
function bankAccountId(v: unknown, label: string): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) {
    throw new Error(`${label}: pick a cash or bank account`);
  }
  return v;
}

/** The same, off a form field. */
function formBankAccountId(formData: FormData, field: string): number {
  const v = Number(formData.get(field));
  if (!Number.isInteger(v) || v <= 0) {
    throw new Error("Pick a cash or bank account for this voucher.");
  }
  return v;
}

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
      bank_account_id: bankAccountId(r.bank_account_id, label),
      include: r.include === true,
    };
  });
}

function saveDraft(book: Book, docId: number, rows: DraftRowInput[]): void {
  const doc = book.get(
    "SELECT * FROM documents WHERE id = @docId AND company_id = @company_id",
    { docId }
  ) as DocumentRow | undefined;
  if (!doc) throw new Error("Document not found.");
  if (doc.status === "posted") {
    throw new Error("Document is posted — its rows are locked.");
  }
  book.tx((b) => applyDraftRows(b, docId, rows));
}

export async function createParty(formData: FormData): Promise<void> {
  const { book } = await requireBook();
  const name = String(formData.get("name") ?? "").trim();
  const kind = String(formData.get("kind") ?? "");
  const gstin = String(formData.get("gstin") ?? "").trim().toUpperCase();
  const pan = String(formData.get("pan") ?? "").trim().toUpperCase();
  const stateCode = String(formData.get("state_code") ?? "").trim();
  const phone = String(formData.get("phone") ?? "").trim();
  if (!name) throw new Error("Party name is required.");
  if (kind !== "customer" && kind !== "supplier") {
    throw new Error("Party kind must be customer or supplier.");
  }
  if (pan !== "" && !/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(pan)) {
    throw new Error("PAN must look like ABCPV1234F (or be left blank).");
  }
  book.run(
    `INSERT INTO parties (company_id, name, kind, gstin, pan, state_code, phone, created_at)
     VALUES (@company_id, @name, @kind, @gstin, @pan, @stateCode, @phone, @now)`,
    { name, kind, gstin, pan, stateCode, phone, now: new Date().toISOString() }
  );
  revalidatePath("/parties");
  redirect("/parties");
}

const ENTITY_TYPES: EntityType[] = ["proprietorship", "partnership", "company"];
const IT_REGIMES: ItRegime[] = ["old", "new"];
const PRESUMPTIVE: Presumptive[] = ["", "44AD", "44ADA"];

export async function updateSettings(formData: FormData): Promise<void> {
  const { book } = await requireBook();
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
  const companyName = String(formData.get("company_name") ?? "").trim() || "My Company";
  updateCompanySettings(book.db, book.companyId, {
    companyName,
    gstin: String(formData.get("gstin") ?? "").trim().toUpperCase(),
    stateCode: String(formData.get("state_code") ?? "").trim(),
    country: String(formData.get("country") ?? "IN").trim().toUpperCase() || "IN",
    currency: String(formData.get("currency") ?? "INR").trim().toUpperCase() || "INR",
    rate: Number.isFinite(rate) ? rate : 18,
    taxInclusive: formData.get("tax_inclusive") === "on" ? 1 : 0,
    entityType: entityType as EntityType,
    pan: String(formData.get("pan") ?? "").trim().toUpperCase(),
    tan: String(formData.get("tan") ?? "").trim().toUpperCase(),
    itRegime,
    presumptive,
    lockedThrough,
    fyAuditCase: formData.get("fy_audit_case") === "on" ? 1 : 0,
  });
  revalidatePath("/settings");
  redirect("/settings");
}

const COMPANY_ENTITY_TYPES: EntityType[] = ["proprietorship", "partnership", "company"];

/**
 * Point THIS session at a company. See the long comment on
 * `setSessionCompany` (auth.ts) for why a company id in a form field here
 * does not violate invariant T2 — this is the one deliberate exception, and
 * every other action in this file must keep reading its company from the
 * session, never from an input.
 */
export async function switchCompany(formData: FormData): Promise<void> {
  await requireSession();
  const companyId = Number(formData.get("company_id"));
  if (!Number.isInteger(companyId) || companyId < 1) {
    throw new Error("Choose a company.");
  }
  setSessionCompany(getDb(), await readSessionToken(), companyId);
  revalidatePath("/", "layout");
  redirect("/");
}

/** Onboarding a new client (RVOS-004 P4): create the company row, then seed
 * its own chart of accounts immediately — a company with zero accounts can't
 * post anything, so leaving this to a later manual step just means the first
 * voucher fails with a confusing error. Opening balances are still a
 * separate, deliberate step (docs/DAY-ONE.md §4): the app cannot guess a
 * client's numbers. */
export async function createCompanyAction(formData: FormData): Promise<void> {
  await requireSession();
  const entityType = String(formData.get("entity_type") ?? "proprietorship");
  if (!COMPANY_ENTITY_TYPES.includes(entityType as EntityType)) {
    throw new Error("Unknown entity type.");
  }
  const db = getDb();
  // One transaction: a company row committed with no chart of accounts is
  // exactly the postable-empty state this feature exists to prevent (caught
  // in code review) — if seeding throws, the create must roll back with it.
  db.transaction((): void => {
    const id = createCompany(
      db,
      {
        name: String(formData.get("name") ?? ""),
        entityType: entityType as EntityType,
        pan: String(formData.get("pan") ?? ""),
        tan: String(formData.get("tan") ?? ""),
        gstin: String(formData.get("gstin") ?? ""),
        stateCode: String(formData.get("state_code") ?? ""),
      },
      new Date().toISOString()
    );
    seedAccountsForCompany(db, id);
  })();
  revalidatePath("/companies");
  redirect("/companies");
}

export async function renameCompanyAction(formData: FormData): Promise<void> {
  await requireSession();
  const id = Number(formData.get("company_id"));
  if (!Number.isInteger(id) || id < 1) throw new Error("Choose a company.");
  renameCompany(getDb(), id, String(formData.get("name") ?? ""));
  revalidatePath("/companies");
  revalidatePath("/", "layout");
  redirect("/companies");
}

/** Archive-only — see companies.ts. A client's books are never deleted from
 * here, one click or otherwise. */
export async function archiveCompanyAction(formData: FormData): Promise<void> {
  await requireSession();
  const id = Number(formData.get("company_id"));
  if (!Number.isInteger(id) || id < 1) throw new Error("Choose a company.");
  archiveCompany(getDb(), id, new Date().toISOString());
  revalidatePath("/companies");
  revalidatePath("/", "layout");
  redirect("/companies");
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
  const { book } = await requireBook();
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
  const existing = book.get(
    "SELECT id FROM accounts WHERE company_id = @company_id AND code = @code",
    { code }
  );
  if (existing) throw new Error(`Account code ${code} already exists.`);
  book.run(
    `INSERT INTO accounts (company_id, code, name, type, group_code)
     VALUES (@company_id, @code, @name, @type, @groupCode)`,
    { code, name, type, groupCode }
  );
  revalidatePath("/settings/accounts");
  redirect("/settings/accounts");
}

export async function renameAccount(formData: FormData): Promise<void> {
  const { book } = await requireBook();
  const id = Number(formData.get("id"));
  const name = String(formData.get("name") ?? "").trim();
  if (!Number.isInteger(id) || id <= 0) throw new Error("Bad account id.");
  if (!name) throw new Error("Account name is required.");
  book.run(
    "UPDATE accounts SET name = @name WHERE id = @id AND company_id = @company_id",
    { id, name }
  );
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
  const { book } = await requireBook();
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
    input = {
      kind,
      entry_date,
      memo,
      ref_no,
      from_bank_account_id: formBankAccountId(formData, "from_bank_account_id"),
      to_bank_account_id: formBankAccountId(formData, "to_bank_account_id"),
      amount_paise: amount(),
    };
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
      bank_account_id: formBankAccountId(formData, "bank_account_id"),
    };
  } else {
    throw new Error("Unknown voucher kind.");
  }

  const { journalId } = postManualVoucher(book, input);
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
  const { book } = await requireBook();
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Party name is required.");
  if (kind !== "customer" && kind !== "supplier") {
    throw new Error("Party kind must be customer or supplier.");
  }
  const id = book.run(
    `INSERT INTO parties (company_id, name, kind, gstin, state_code, phone, created_at)
     VALUES (@company_id, @name, @kind, '', '', '', @now)`,
    { name: trimmed, kind, now: new Date().toISOString() }
  ).lastInsertRowid as number;
  revalidatePath("/parties");
  return { id: Number(id), name: trimmed };
}

/** Step 2 of the Tally import: persist the ledger mappings the user just
 * chose, re-read the parked Day Book against them, and stage every voucher —
 * mappings, document and rows in ONE transaction, so a failure anywhere
 * leaves neither half-saved mappings nor an orphan document. Everything reads
 * and writes through the ACTIVE company's Book (RVOS-004 P4) — an import
 * lands in the session's chosen client, never a hardcoded or guessed one. */
export async function createTallyImport(formData: FormData): Promise<void> {
  const { book } = await requireBook();
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

  if (
    !book.get("SELECT id FROM parties WHERE id = @id AND company_id = @company_id", {
      id: partyId,
    })
  ) {
    throw new Error("Party not found.");
  }
  const partyIds = new Set(
    book
      .all<{ id: number }>("SELECT id FROM parties WHERE company_id = @company_id")
      .map((p) => p.id)
  );
  const accountIds = new Set(
    book
      .all<{ id: number }>("SELECT id FROM accounts WHERE company_id = @company_id")
      .map((a) => a.id)
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

  const settings = getCompany(book.db, book.companyId)!;

  const docId = finalizeTallyImport(book, {
    partyId,
    mappings: chosen,
    vouchers,
    taxInclusive: settings.tax_inclusive === 1,
    imagePath: path.join("data", "uploads", token),
    sha256,
    now,
  });

  revalidatePath("/documents");
  revalidatePath("/imports");
  redirect(`/documents/${docId}`);
}

// ---------------------------------------------------------------------------
// Fixed assets + IT-Act depreciation
// ---------------------------------------------------------------------------

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Rupee text from a form field → integer paise. Uses the exact-string path,
 * never parseFloat, so ₹1,00,000.50 can't drift. */
function formPaise(formData: FormData, field: string, label: string): number {
  const raw = String(formData.get(field) ?? "").trim();
  if (raw === "") throw new Error(`${label} is required.`);
  let paise: number;
  try {
    paise = rupeeStringToPaise(raw);
  } catch (e) {
    throw new Error(`${label}: ${e instanceof Error ? e.message : "bad amount"}`);
  }
  if (paise < 0) throw new Error(`${label} must not be negative.`);
  return paise;
}

export async function createAsset(formData: FormData): Promise<void> {
  const { book } = await requireBook();
  const name = String(formData.get("name") ?? "").trim();
  const block = String(formData.get("block") ?? "");
  const purchaseDate = String(formData.get("purchase_date") ?? "").trim();
  const putToUseRaw = String(formData.get("put_to_use_date") ?? "").trim();
  if (!name) throw new Error("Asset name is required.");
  if (!blockFor(block)) throw new Error("Pick a depreciation block.");
  if (!ISO_DATE.test(purchaseDate)) {
    throw new Error("Purchase date is required (YYYY-MM-DD).");
  }
  if (putToUseRaw !== "" && !ISO_DATE.test(putToUseRaw)) {
    throw new Error("Put-to-use date must be a date (YYYY-MM-DD) or blank.");
  }
  // Depreciation starts when the asset is USED, not when it is bought.
  const putToUse = putToUseRaw === "" ? null : putToUseRaw;
  if (putToUse !== null && putToUse < purchaseDate) {
    throw new Error("An asset can't be put to use before it was bought.");
  }
  const cost = formPaise(formData, "cost", "Cost");
  if (cost === 0) throw new Error("Cost must be more than zero.");

  book.run(
    `INSERT INTO fixed_assets
       (company_id, name, block, cost_paise, purchase_date, put_to_use_date, created_at)
     VALUES (@company_id, @name, @block, @cost, @purchaseDate, @putToUse, @now)`,
    { name, block, cost, purchaseDate, putToUse, now: new Date().toISOString() }
  );
  revalidatePath("/tax/depreciation");
  redirect("/tax/depreciation");
}

export async function disposeAsset(formData: FormData): Promise<void> {
  const { book } = await requireBook();
  const id = Number(formData.get("id"));
  const disposedDate = String(formData.get("disposed_date") ?? "").trim();
  if (!Number.isInteger(id) || id <= 0) throw new Error("Bad asset id.");
  if (!ISO_DATE.test(disposedDate)) {
    throw new Error("Disposal date is required (YYYY-MM-DD).");
  }
  const proceeds = formPaise(formData, "disposal", "Sale proceeds");

  const asset = book.get(
    "SELECT * FROM fixed_assets WHERE id = @id AND company_id = @company_id",
    { id }
  ) as FixedAssetRow | undefined;
  if (!asset) throw new Error("Asset not found.");
  if (asset.disposed_date) throw new Error("That asset is already disposed.");
  if (disposedDate < asset.purchase_date) {
    throw new Error("An asset can't be sold before it was bought.");
  }
  // An asset that never entered a block can't leave one: its cost was never
  // added, so booking proceeds against the block would cut the depreciation
  // of every other asset in it.
  if (!asset.put_to_use_date) {
    throw new Error(
      "That asset was never put to use, so it never entered a depreciation block — record the sale as a manual voucher instead."
    );
  }
  if (disposedDate < asset.put_to_use_date) {
    throw new Error("An asset can't be sold before it was put to use.");
  }
  book.run(
    "UPDATE fixed_assets SET disposed_date = @disposedDate, disposal_paise = @proceeds WHERE id = @id AND company_id = @company_id",
    { disposedDate, proceeds, id }
  );
  revalidatePath("/tax/depreciation");
  redirect("/tax/depreciation");
}

/**
 * Book the FY's depreciation: Dr 5800 Depreciation / Cr 1590 Accumulated
 * Depreciation, dated the last day of the FY, ONE entry per year.
 *
 * The amount is computed from the block schedule, never typed in. The guard
 * against a second entry is a query for an existing 'depreciation' journal
 * inside the FY — with post-only books there is no un-post, so a double
 * click here would need a manual reversing entry to undo.
 */
export async function postDepreciationEntry(formData: FormData): Promise<void> {
  const { book } = await requireBook();
  const fy = String(formData.get("fy") ?? "").trim();
  const to = fyEnd(fy); // the entry is dated the last day of the year

  // Guard and insert in ONE transaction (postManualVoucher's own transaction
  // nests as a savepoint). Checking outside it would let two quick submits
  // both pass the guard before either wrote — and with post-only books the
  // duplicate could only be undone by a manual reversing entry.
  const journalId = book.tx((b): number => {
    const existing = postedDepreciation(b, fy);
    if (existing) {
      throw new Error(
        `${fyLabel(fy)} depreciation is already posted (journal #${existing.id}). Books are post-only — correct it with a manual reversing entry.`
      );
    }
    const schedule = depreciationSchedule(b, fy);
    if (schedule.total_depreciation_paise <= 0) {
      throw new Error(
        `Nothing to depreciate in ${fyLabel(fy)} — add assets and their put-to-use dates first.`
      );
    }
    return postManualVoucher(b, {
      kind: "journal",
      entry_type: "depreciation",
      entry_date: to,
      memo: `Depreciation for ${fyLabel(fy)} (IT-Act WDV)`,
      ref_no: `DEP-${fy}`,
      legs: [
        {
          account_code: "5800",
          party_id: null,
          debit_paise: schedule.total_depreciation_paise,
          credit_paise: 0,
        },
        {
          account_code: "1590",
          party_id: null,
          debit_paise: 0,
          credit_paise: schedule.total_depreciation_paise,
        },
      ],
    }).journalId;
  });
  revalidatePath("/tax/depreciation");
  revalidatePath("/reports");
  revalidatePath("/");
  redirect(`/tax/depreciation?fy=${fy}&posted=${journalId}`);
}

// ---------------------------------------------------------------------------
// Income-tax computation metadata (never posted — freely editable)
// ---------------------------------------------------------------------------

export async function addItAdjustment(formData: FormData): Promise<void> {
  const { book } = await requireBook();
  const fy = String(formData.get("fy") ?? "").trim();
  fyStart(fy); // throws on a malformed FY key
  const kind = String(formData.get("kind") ?? "");
  if (kind !== "addback" && kind !== "deduction") {
    throw new Error("Adjustment must be an addback or a deduction.");
  }
  const description = String(formData.get("description") ?? "").trim();
  if (!description) throw new Error("Describe the adjustment.");
  const amount = formPaise(formData, "amount", "Amount");
  if (amount === 0) throw new Error("Amount must be more than zero.");

  book.run(
    `INSERT INTO it_adjustments (company_id, fy, kind, section, description, amount_paise, created_at)
     VALUES (@company_id, @fy, @kind, @section, @description, @amount, @now)`,
    {
      fy,
      kind,
      section: String(formData.get("section") ?? "").trim(),
      description,
      amount,
      now: new Date().toISOString(),
    }
  );
  revalidatePath("/tax/computation");
  redirect(`/tax/computation?fy=${fy}`);
}

export async function deleteItAdjustment(formData: FormData): Promise<void> {
  const { book } = await requireBook();
  const id = Number(formData.get("id"));
  const fy = String(formData.get("fy") ?? "").trim();
  if (!Number.isInteger(id) || id <= 0) throw new Error("Bad adjustment id.");
  // Safe to delete outright: adjustments are computation metadata, never
  // posted to the books, so nothing references them.
  book.run("DELETE FROM it_adjustments WHERE id = @id AND company_id = @company_id", { id });
  revalidatePath("/tax/computation");
  redirect(`/tax/computation?fy=${fy}`);
}

export async function addTaxPayment(formData: FormData): Promise<void> {
  const { book } = await requireBook();
  const fy = String(formData.get("fy") ?? "").trim();
  fyStart(fy);
  const kind = String(formData.get("kind") ?? "");
  if (kind !== "advance" && kind !== "tds" && kind !== "self_assessment") {
    throw new Error("Payment must be advance tax, TDS, or self-assessment.");
  }
  const paidOn = String(formData.get("paid_on") ?? "").trim();
  if (!ISO_DATE.test(paidOn)) {
    throw new Error("Payment date is required (YYYY-MM-DD).");
  }
  const amount = formPaise(formData, "amount", "Amount");
  if (amount === 0) throw new Error("Amount must be more than zero.");

  book.run(
    `INSERT INTO tax_payments (company_id, fy, kind, paid_on, amount_paise, note, created_at)
     VALUES (@company_id, @fy, @kind, @paidOn, @amount, @note, @now)`,
    {
      fy,
      kind,
      paidOn,
      amount,
      note: String(formData.get("note") ?? "").trim(),
      now: new Date().toISOString(),
    }
  );
  revalidatePath("/tax/computation");
  redirect(`/tax/computation?fy=${fy}`);
}

// ---------------------------------------------------------------------------
// TDS — deduct on payment, deposit on challan
// ---------------------------------------------------------------------------

/** Pay a bill net of TDS — one journal + one register row, atomically. */
export async function createTdsVoucher(formData: FormData): Promise<void> {
  const { book } = await requireBook();
  const entry_date = String(formData.get("entry_date") ?? "").trim();
  if (!ISO_DATE.test(entry_date)) {
    throw new Error("Payment date is required (YYYY-MM-DD).");
  }
  const party_id = Number(formData.get("party_id"));
  if (!Number.isInteger(party_id) || party_id <= 0) {
    throw new Error("Pick the payee.");
  }
  const section = String(formData.get("section") ?? "");
  if (!tdsSection(section)) throw new Error("Pick a TDS section.");
  const base_paise = formPaise(formData, "base", "Bill amount");
  if (base_paise === 0) throw new Error("Bill amount must be more than zero.");

  const overrideRaw = String(formData.get("tds_override") ?? "").trim();
  let tds_paise_override: number | null = null;
  if (overrideRaw !== "") {
    tds_paise_override = rupeeStringToPaise(overrideRaw);
    if (tds_paise_override < 0) throw new Error("TDS must not be negative.");
  }

  postVoucherWithTds(book, {
    entry_date,
    memo: String(formData.get("memo") ?? "").trim(),
    ref_no: String(formData.get("ref_no") ?? "").trim(),
    party_id,
    expense_account_code: "5900",
    base_paise,
    section,
    use_alt: formData.get("use_alt") === "on",
    bank_account_id: formBankAccountId(formData, "bank_account_id"),
    tds_paise_override,
  });
  revalidatePath("/tax/tds");
  revalidatePath("/reports");
  revalidatePath("/");
  redirect("/tax/tds");
}

/**
 * Deposit the undeposited deductions of one quarter: Dr 2300 / Cr Bank, a
 * challan row, and the covered entries stamped — ONE transaction. The amount
 * is computed from the entries being covered, never typed, so the challan can
 * neither over- nor under-clear account 2300.
 */
export async function createTdsChallan(formData: FormData): Promise<void> {
  const { book } = await requireBook();
  const fy = String(formData.get("fy") ?? "").trim();
  fyStart(fy);
  const quarter = Number(formData.get("quarter"));
  if (![1, 2, 3, 4].includes(quarter)) throw new Error("Pick a quarter.");
  const form = String(formData.get("form") ?? "26Q");
  if (form !== "26Q" && form !== "24Q") {
    throw new Error("A challan covers either 26Q (non-salary) or 24Q (salary).");
  }
  const paid_on = String(formData.get("paid_on") ?? "").trim();
  if (!ISO_DATE.test(paid_on)) {
    throw new Error("Deposit date is required (YYYY-MM-DD).");
  }
  const challan_no = String(formData.get("challan_no") ?? "").trim();
  const bsr_code = String(formData.get("bsr_code") ?? "").trim();

  const q = QUARTER_RANGES[quarter as 1 | 2 | 3 | 4](fy);
  book.tx((b) => {
    // One challan covers one return form: mixing salary and non-salary
    // deductions in a single deposit would make the 26Q/24Q undeposited
    // figures impossible to reconcile from the challan rows.
    const pending = b.all<{ id: number; tds_paise: number }>(
      `SELECT id, tds_paise FROM tds_entries
       WHERE company_id = @company_id AND challan_id IS NULL
         AND entry_date BETWEEN @from AND @to
         AND (CASE WHEN @form = '24Q' THEN section = '192B' ELSE section <> '192B' END)`,
      { from: q.from, to: q.to, form }
    );
    const amount = pending.reduce((s, e) => s + e.tds_paise, 0);
    if (amount <= 0) {
      throw new Error(`Nothing undeposited for ${form} in that quarter.`);
    }
    const { journalId } = postManualVoucher(b, {
      kind: "journal",
      entry_type: "tds_challan",
      entry_date: paid_on,
      memo: `TDS deposit (${form}) — Q${quarter} ${fyLabel(fy)}`,
      ref_no: challan_no,
      legs: [
        { account_code: "2300", party_id: null, debit_paise: amount, credit_paise: 0 },
        { account_code: "1100", party_id: null, debit_paise: 0, credit_paise: amount },
      ],
    });
    const challanId = b.run(
      `INSERT INTO tds_challans
         (company_id, fy, quarter, form, challan_no, bsr_code, paid_on, amount_paise, journal_id, created_at)
       VALUES (@company_id, @fy, @quarter, @form, @challan_no, @bsr_code, @paid_on, @amount, @journalId, @now)`,
      { fy, quarter, form, challan_no, bsr_code, paid_on, amount, journalId, now: new Date().toISOString() }
    ).lastInsertRowid as number;
    for (const e of pending) {
      b.run(
        "UPDATE tds_entries SET challan_id = @challanId WHERE id = @id AND company_id = @company_id",
        { challanId, id: e.id }
      );
    }
  });
  revalidatePath("/tax/tds");
  revalidatePath("/reports");
  redirect(`/tax/tds?fy=${fy}&q=${quarter}`);
}

/** FY quarter date ranges, Apr-start. */
const QUARTER_RANGES: Record<1 | 2 | 3 | 4, (fy: string) => { from: string; to: string }> = {
  1: (fy) => ({ from: fyStart(fy), to: `${fyStart(fy).slice(0, 4)}-06-30` }),
  2: (fy) => ({ from: `${fyStart(fy).slice(0, 4)}-07-01`, to: `${fyStart(fy).slice(0, 4)}-09-30` }),
  3: (fy) => ({ from: `${fyStart(fy).slice(0, 4)}-10-01`, to: `${fyStart(fy).slice(0, 4)}-12-31` }),
  4: (fy) => ({ from: `${Number(fyStart(fy).slice(0, 4)) + 1}-01-01`, to: fyEnd(fy) }),
};

// ---------------------------------------------------------------------------
// Compliance calendar — marks are metadata, never posted
// ---------------------------------------------------------------------------

/**
 * Mark a board item done / not-applicable, or clear a wrong mark.
 *
 * Marking validates BOTH axes the form filters (EVOLUTION #11/#17): the FY
 * against the same fyList the page's select renders, and (rule_code, period)
 * against the SAME engine output that rendered the board — real settings,
 * real tds_entries. Any superset re-opens the bypass: a hidden GST/TDS item —
 * or a future FY's whole board — could arrive pre-marked "done" the day the
 * GSTIN/TAN is filled in or that FY opens.
 *
 * Clearing is gated differently, on the mark EXISTING: a delete destroys
 * only the office's own metadata and can pre-mark nothing, while gating it
 * on current board membership would trap a wrong mark whose regime later
 * switched off — invisible, uncorrectable, and resurfacing as "done" the
 * day the regime returns.
 */
export async function markCompliance(formData: FormData): Promise<void> {
  const { book } = await requireBook();
  const fy = String(formData.get("fy") ?? "").trim();
  fyStart(fy); // throws on a malformed FY key
  const rule_code = String(formData.get("rule_code") ?? "");
  const period = String(formData.get("period") ?? "");
  const status = String(formData.get("status") ?? "");
  if (status !== "done" && status !== "na" && status !== "clear") {
    throw new Error("A mark is done, na, or clear.");
  }

  if (status === "clear") {
    const gone = book.run(
      "DELETE FROM compliance_marks WHERE company_id = @company_id AND rule_code = @rule_code AND period = @period",
      { rule_code, period }
    );
    if (gone.changes === 0) {
      throw new Error(`No mark to clear: ${rule_code} ${period}.`);
    }
  } else {
    if (!fyList(book).includes(fy)) {
      throw new Error(`FY ${fy} is not on the books.`);
    }
    const settings = getCompany(book.db, book.companyId)!;
    const valid = generateItems(book, fy, settings, todayIso());
    if (!valid.some((i) => i.rule_code === rule_code && i.period === period)) {
      throw new Error(`No such compliance item on the board: ${rule_code} ${period}.`);
    }
    book.run(
      `INSERT INTO compliance_marks (company_id, rule_code, period, status, marked_at, note)
       VALUES (@company_id, @rule_code, @period, @status, @marked_at, @note)
       ON CONFLICT (company_id, rule_code, period) DO UPDATE SET
         status = excluded.status, marked_at = excluded.marked_at, note = excluded.note`,
      {
        rule_code,
        period,
        status,
        marked_at: new Date().toISOString(),
        note: String(formData.get("note") ?? "").trim(),
      }
    );
  }
  revalidatePath("/compliance");
  redirect(`/compliance?fy=${fy}`);
}

export async function runExtraction(docId: number): Promise<void> {
  const { book } = await requireBook();
  try {
    await extractDocument(book, docId);
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
  const { book } = await requireBook();
  saveDraft(book, docId, parseDraftRows(rowsJson));
  revalidatePath(`/documents/${docId}`);
}

export async function saveAndPost(
  docId: number,
  rowsJson: string
): Promise<void> {
  const { book } = await requireBook();
  postDocument(book, docId, parseDraftRows(rowsJson));
  revalidatePath(`/documents/${docId}`);
  revalidatePath("/documents");
  revalidatePath("/");
}

export async function deleteDocument(docId: number): Promise<void> {
  const { book } = await requireBook();
  const doc = book.get(
    "SELECT * FROM documents WHERE id = @docId AND company_id = @company_id",
    { docId }
  ) as DocumentRow | undefined;
  if (!doc) throw new Error("Document not found.");
  if (doc.status === "posted") {
    throw new Error(
      "Posted documents cannot be deleted — the books reference them. Fix forward with an opposite entry."
    );
  }
  book.run("DELETE FROM documents WHERE id = @docId AND company_id = @company_id", { docId }); // staged rows cascade
  await unlink(path.join(process.cwd(), doc.image_path)).catch(() => {});
  revalidatePath("/documents");
  redirect("/documents");
}

// ---------------------------------------------------------------------------
// Bank, cash and wallet accounts — RVOS-006 P0a
// ---------------------------------------------------------------------------

export async function createBankAccountAction(formData: FormData): Promise<void> {
  const { book } = await requireBook();
  const kind = String(formData.get("kind") ?? "");
  if (kind !== "bank" && kind !== "cash" && kind !== "wallet" && kind !== "card") {
    throw new Error("Pick an account kind.");
  }
  const ifsc = String(formData.get("ifsc") ?? "").trim().toUpperCase();
  if (ifsc !== "" && !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc)) {
    throw new Error("IFSC must look like HDFC0001234 (or be left blank).");
  }
  createBankAccount(book, {
    name: String(formData.get("name") ?? ""),
    kind,
    account_no: String(formData.get("account_no") ?? ""),
    ifsc,
    is_default: formData.get("is_default") === "on",
  });
  revalidatePath("/settings/bank-accounts");
  revalidatePath("/vouchers");
  redirect("/settings/bank-accounts");
}

export async function renameBankAccountAction(formData: FormData): Promise<void> {
  const { book } = await requireBook();
  renameBankAccount(book, Number(formData.get("id")), String(formData.get("name") ?? ""));
  revalidatePath("/settings/bank-accounts");
  revalidatePath("/settings/accounts");
  redirect("/settings/bank-accounts");
}

export async function setDefaultBankAccountAction(formData: FormData): Promise<void> {
  const { book } = await requireBook();
  setDefaultBankAccount(book, Number(formData.get("id")));
  revalidatePath("/settings/bank-accounts");
  redirect("/settings/bank-accounts");
}

export async function archiveBankAccountAction(formData: FormData): Promise<void> {
  const { book } = await requireBook();
  archiveBankAccount(book, Number(formData.get("id")), new Date().toISOString());
  revalidatePath("/settings/bank-accounts");
  redirect("/settings/bank-accounts");
}
