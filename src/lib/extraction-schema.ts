import type { EntryType, SettleHint } from "./types";
import { GST_RATES } from "./tax/india-gst";
import { toPaise } from "./format";

/** Model output → staged-row shape. Pure — no db, unit-tested. */

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

export interface ExtractionPage {
  party_name_hint: string | null;
  period_hint: string | null;
  has_balance_column: boolean;
  notes: string;
}

export interface ValidatedRow {
  row_no: number;
  entry_date: string | null;
  particulars: string;
  ref_no: string;
  debit_paise: number | null;
  credit_paise: number | null;
  entry_type: EntryType;
  gst_rate: number | null;
  /** Coarse cash-vs-bank hint, NOT an account — the model is never asked which
   * of the office's accounts a line means, because it cannot know. Resolved to
   * a real account at staging time (see bank-accounts.ts). */
  settle_hint: SettleHint;
  confidence: number;
  is_balance_row: boolean;
  include: boolean;
}

export interface ExtractionResult {
  page: ExtractionPage;
  rows: ValidatedRow[];
}

/** Pull the outermost JSON object out of a model reply: strip ``` fences,
 * slice from the first { to the last }. (Ported from scout-dashboard.) */
export function extractJsonObject(reply: string): string {
  const fenced = reply.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced ? fenced[1] : reply).trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("no JSON object in reply");
  return candidate.slice(start, end + 1);
}

const BANK_HINT = /\b(bank|neft|rtgs|imps|upi|cheque|chq|transfer)\b/i;

function fail(rowNo: number | null, msg: string): never {
  throw new Error(rowNo === null ? msg : `row ${rowNo}: ${msg}`);
}

function amountToPaise(v: unknown, side: string, rowNo: number): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== "number" || !Number.isFinite(v)) {
    fail(rowNo, `${side} must be a number or null`);
  }
  if (v < 0) fail(rowNo, `${side} is negative`);
  const paise = toPaise(v);
  return paise === 0 ? null : paise;
}

function cleanDate(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const m = v.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const [, , mm, dd] = m;
  if (Number(mm) < 1 || Number(mm) > 12 || Number(dd) < 1 || Number(dd) > 31) return null;
  return m[0];
}

/**
 * Validate + normalize a parsed extraction reply.
 * Hard errors (throw → the caller retries with a nudge): missing/oversized
 * rows array, a row with BOTH debit and credit, unknown entry_type, gst_rate
 * outside the regime's set, non-numeric amounts.
 * Normalizations: rupees → integer paise; confidence clamped to 0–1; null or
 * malformed dates inherit from the previous row (ditto marks); balance rows
 * default to excluded; receipts/payments that read like bank movements
 * default settle_hint to bank.
 */
export function validateExtraction(parsed: unknown): ExtractionResult {
  if (typeof parsed !== "object" || parsed === null) {
    fail(null, "reply is not a JSON object");
  }
  const obj = parsed as Record<string, unknown>;

  const pageIn = (obj.page ?? {}) as Record<string, unknown>;
  const page: ExtractionPage = {
    party_name_hint:
      typeof pageIn.party_name_hint === "string" ? pageIn.party_name_hint : null,
    period_hint:
      typeof pageIn.period_hint === "string" ? pageIn.period_hint : null,
    has_balance_column: pageIn.has_balance_column === true,
    notes: typeof pageIn.notes === "string" ? pageIn.notes : "",
  };

  if (!Array.isArray(obj.rows)) fail(null, "rows must be an array");
  if (obj.rows.length < 1) fail(null, "rows is empty — a ledger page has at least one row");
  if (obj.rows.length > 80) fail(null, `rows has ${obj.rows.length} entries — a single page has at most 80`);

  let prevDate: string | null = null;
  const rows: ValidatedRow[] = obj.rows.map((rawRow, i) => {
    const rowNo = i + 1;
    if (typeof rawRow !== "object" || rawRow === null) fail(rowNo, "row is not an object");
    const r = rawRow as Record<string, unknown>;

    const debit_paise = amountToPaise(r.debit, "debit", rowNo);
    const credit_paise = amountToPaise(r.credit, "credit", rowNo);
    if (debit_paise !== null && credit_paise !== null) {
      fail(rowNo, "has BOTH debit and credit — a ledger row has exactly one side");
    }

    const entry_type = r.entry_type;
    if (typeof entry_type !== "string" || !ENTRY_TYPES.includes(entry_type as EntryType)) {
      fail(rowNo, `unknown entry_type ${JSON.stringify(r.entry_type)}`);
    }

    let gst_rate: number | null = null;
    if (r.gst_rate !== null && r.gst_rate !== undefined) {
      if (
        typeof r.gst_rate !== "number" ||
        !GST_RATES.includes(r.gst_rate as (typeof GST_RATES)[number])
      ) {
        fail(rowNo, `gst_rate must be one of ${GST_RATES.join("/")} or null`);
      }
      gst_rate = r.gst_rate;
    }

    const confidence =
      typeof r.confidence === "number" && Number.isFinite(r.confidence)
        ? Math.min(1, Math.max(0, r.confidence))
        : 0;

    // Ditto marks / torn corners: a missing date inherits the previous row's.
    const ownDate = cleanDate(r.entry_date);
    const entry_date = ownDate ?? prevDate;
    prevDate = entry_date;

    const is_balance_row = r.is_balance_row === true;
    const particulars =
      typeof r.particulars === "string" ? r.particulars.trim() : "";

    let settle_hint: SettleHint = r.settle_hint === "bank" ? "bank" : "cash";
    if (
      r.settle_hint === undefined &&
      (entry_type === "receipt" || entry_type === "payment") &&
      BANK_HINT.test(particulars)
    ) {
      settle_hint = "bank";
    }

    return {
      row_no: typeof r.row_no === "number" ? r.row_no : rowNo,
      entry_date,
      particulars,
      ref_no: typeof r.ref_no === "string" ? r.ref_no.trim() : "",
      debit_paise,
      credit_paise,
      entry_type: entry_type as EntryType,
      gst_rate,
      settle_hint,
      confidence,
      is_balance_row,
      include: !is_balance_row,
    };
  });

  return { page, rows };
}
