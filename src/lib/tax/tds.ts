import type Database from "better-sqlite3";
import { fyEnd, fyStart, quarterOf } from "../fy";
import { roundHalfUp } from "./india-gst";
import type { TdsEntryRow } from "../types";

/**
 * TDS — tax deducted at source on payments the business makes.
 *
 * The deduction is not a separate ledger exercise: it splits an existing
 * payment. A ₹10,000 contractor bill paid by bank becomes Dr 5900 ₹10,000 /
 * Cr 2300 ₹100 / Cr Bank ₹9,900 — one journal, with a register row pointing
 * at it. That link is the whole design: the register can never drift from the
 * books because it is derived from a journal that exists (see
 * postVoucherWithTds, which writes both in one transaction).
 *
 * Rates are basis points to keep the arithmetic in integers — 1% is 100 bp, so
 * tds = base * bp / 10000 with a single rounding step.
 *
 * SECTION CODES: these are the codes the office knows and that appear on
 * challans and quarterly returns, so they are used as identifiers. But the
 * Income-tax Act, 2025 renumbered the statute from 1 April 2026, and this
 * table has NOT been confirmed against the current return schema — same
 * caveat as india-it.ts, and `verified` says so on every section. Confirm
 * before a return is filed from these.
 */

export interface TdsSection {
  /** The code as written on a challan / return line. */
  code: string;
  label: string;
  /** Default rate in basis points (1% = 100). */
  bp: number;
  /** Some sections carry a second rate for a different payee or use. */
  alt?: { bp: number; label: string };
  /** Single-payment threshold below which no deduction is required, in paise;
   * null where the office must apply an aggregate/annual test itself. */
  threshold_paise: number | null;
  note: string;
  /** False = the rate has not been confirmed against the Act. */
  verified: boolean;
}

const LAKH = 10_000_000;

export const TDS_SECTIONS: TdsSection[] = [
  {
    code: "194C",
    label: "Contractors",
    bp: 100,
    alt: { bp: 200, label: "Non-individual / company payee" },
    threshold_paise: 30_000 * 100,
    note: "1% for an individual or HUF payee, 2% otherwise. Aggregate annual test applies as well as the single-payment one.",
    verified: false,
  },
  {
    code: "194J",
    label: "Professional / technical fees",
    bp: 1000,
    alt: { bp: 200, label: "Technical services / call-centre" },
    threshold_paise: 30_000 * 100,
    note: "10% for professional fees; 2% for technical services.",
    verified: false,
  },
  {
    code: "194I",
    label: "Rent",
    bp: 1000,
    alt: { bp: 200, label: "Plant & machinery" },
    threshold_paise: 2.4 * LAKH,
    note: "10% for land, building or furniture; 2% for plant & machinery.",
    verified: false,
  },
  {
    code: "194H",
    label: "Commission / brokerage",
    bp: 200,
    threshold_paise: 20_000 * 100,
    note: "2% on commission or brokerage.",
    verified: false,
  },
  {
    code: "192B",
    label: "Salary",
    bp: 0,
    threshold_paise: null,
    note: "Computed per employee on estimated annual salary — enter the amount manually; this app does not run payroll.",
    verified: false,
  },
];

/** Rate applied when the payee has no PAN, whatever the section says. */
export const NO_PAN_BP = 2000; // 20%

export function tdsSection(code: string): TdsSection | undefined {
  return TDS_SECTIONS.find((s) => s.code === code);
}

export interface TdsComputation {
  section: string;
  base_paise: number;
  bp: number;
  tds_paise: number;
  net_paise: number;
  /** True when the no-PAN rate overrode the section rate. */
  no_pan: boolean;
  /** True when the payment is under the section's single-payment threshold. */
  below_threshold: boolean;
  warnings: string[];
}

/**
 * TDS on one payment. A missing PAN raises the rate to the penal one — that
 * substitution is the point of the flag, so it is reported, never silent.
 *
 * The threshold is reported but NOT auto-applied: sections carry aggregate
 * annual tests this app cannot see, so a payment under the single-payment
 * limit may still be liable. Deciding that is the office's call.
 */
export function computeTds(
  basePaise: number,
  sectionCode: string,
  hasPan: boolean,
  useAlt = false
): TdsComputation {
  const section = tdsSection(sectionCode);
  if (!section) throw new Error(`Unknown TDS section "${sectionCode}".`);
  if (!Number.isInteger(basePaise) || basePaise < 0) {
    throw new Error("TDS base must be a non-negative integer of paise.");
  }

  const sectionBp = useAlt && section.alt ? section.alt.bp : section.bp;
  // The penal rate applies only where it is HIGHER — it is a floor for a
  // missing PAN, not a replacement that could ever reduce the deduction.
  const noPan = !hasPan && NO_PAN_BP > sectionBp;
  const bp = noPan ? NO_PAN_BP : sectionBp;
  const tds = roundHalfUp((basePaise * bp) / 10_000);

  const warnings: string[] = [];
  if (noPan) {
    warnings.push(
      `No PAN on record — deducted at ${NO_PAN_BP / 100}% instead of ${sectionBp / 100}%.`
    );
  }
  const belowThreshold =
    section.threshold_paise !== null && basePaise < section.threshold_paise;
  if (belowThreshold) {
    warnings.push(
      `Under the single-payment threshold for ${section.code}, but the annual aggregate may still cross it — check before skipping the deduction.`
    );
  }
  if (section.bp === 0 && !useAlt) {
    warnings.push(
      `${section.code} has no standard rate here — enter the amount from your own computation.`
    );
  }
  if (!section.verified) {
    warnings.push(
      `The ${section.code} rate in this app is unconfirmed — verify against the Act before filing.`
    );
  }

  return {
    section: section.code,
    base_paise: basePaise,
    bp,
    tds_paise: tds,
    net_paise: basePaise - tds,
    no_pan: noPan,
    below_threshold: belowThreshold,
    warnings,
  };
}

export interface TdsRegisterRow extends TdsEntryRow {
  party_name: string;
  party_pan: string;
  quarter: 1 | 2 | 3 | 4;
}

/** Every deduction in an FY, newest first, with the payee attached. */
export function tdsRegister(
  db: Database.Database,
  fy: string
): TdsRegisterRow[] {
  const rows = db
    .prepare(
      `SELECT t.*, p.name AS party_name, p.pan AS party_pan
       FROM tds_entries t
       JOIN parties p ON p.id = t.party_id
       WHERE t.entry_date BETWEEN ? AND ?
       ORDER BY t.entry_date DESC, t.id DESC`
    )
    .all(fyStart(fy), fyEnd(fy)) as (TdsEntryRow & {
    party_name: string;
    party_pan: string;
  })[];
  return rows.map((r) => ({ ...r, quarter: quarterOf(r.entry_date) }));
}

export interface TdsQuarterLine {
  party_id: number;
  party_name: string;
  party_pan: string;
  section: string;
  deductions: number;
  base_paise: number;
  tds_paise: number;
  /** A return line without a PAN will be rejected — surfaced, not hidden. */
  missing_pan: boolean;
}

export interface TdsQuarterSummary {
  fy: string;
  quarter: 1 | 2 | 3 | 4;
  form: "26Q" | "24Q";
  lines: TdsQuarterLine[];
  total_base_paise: number;
  total_tds_paise: number;
  missing_pan_count: number;
  /** Deducted but not yet linked to a deposited challan. */
  undeposited_paise: number;
}

function summarise(
  db: Database.Database,
  fy: string,
  quarter: 1 | 2 | 3 | 4,
  form: "26Q" | "24Q",
  include: (section: string) => boolean
): TdsQuarterSummary {
  const rows = tdsRegister(db, fy).filter(
    (r) => r.quarter === quarter && include(r.section)
  );
  const byKey = new Map<string, TdsQuarterLine>();
  for (const r of rows) {
    const key = `${r.party_id}:${r.section}`;
    const line = byKey.get(key) ?? {
      party_id: r.party_id,
      party_name: r.party_name,
      party_pan: r.party_pan,
      section: r.section,
      deductions: 0,
      base_paise: 0,
      tds_paise: 0,
      missing_pan: r.party_pan.trim() === "",
    };
    line.deductions += 1;
    line.base_paise += r.base_paise;
    line.tds_paise += r.tds_paise;
    byKey.set(key, line);
  }
  const lines = [...byKey.values()].sort(
    (a, b) => a.party_name.localeCompare(b.party_name) || a.section.localeCompare(b.section)
  );
  return {
    fy,
    quarter,
    form,
    lines,
    total_base_paise: lines.reduce((s, l) => s + l.base_paise, 0),
    total_tds_paise: lines.reduce((s, l) => s + l.tds_paise, 0),
    missing_pan_count: lines.filter((l) => l.missing_pan).length,
    undeposited_paise: rows
      .filter((r) => r.challan_id === null)
      .reduce((s, r) => s + r.tds_paise, 0),
  };
}

/** 26Q — deductions other than salary. */
export function q26Summary(
  db: Database.Database,
  fy: string,
  quarter: 1 | 2 | 3 | 4
): TdsQuarterSummary {
  return summarise(db, fy, quarter, "26Q", (s) => s !== "192B");
}

/** 24Q — salary deductions. */
export function q24Summary(
  db: Database.Database,
  fy: string,
  quarter: 1 | 2 | 3 | 4
): TdsQuarterSummary {
  return summarise(db, fy, quarter, "24Q", (s) => s === "192B");
}
