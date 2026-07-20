import type Database from "better-sqlite3";
import { fyEnd, fyStart } from "../fy";
import { profitAndLoss } from "../reports";
import { depreciationSchedule } from "./depreciation";
import {
  advanceTaxSchedule,
  partnerRemunerationCeiling,
  presumptiveIncome,
  ratesFor,
  roundToTenRupees,
  taxFor,
  type AdvanceTaxInstalment,
  type TaxResult,
} from "./india-it";
import type {
  ItAdjustmentRow,
  SettingsRow,
  TaxPaymentRow,
} from "../types";

/**
 * Book profit → taxable income → tax payable, for one financial year.
 *
 * The bridge from accounts to tax is the part worth reading: book profit is
 * NOT taxable income. Depreciation charged in the books comes back out and the
 * Income-tax Act's own block depreciation goes in instead, then the office's
 * addbacks and deductions apply. Under a presumptive scheme none of that runs
 * — income is a flat percentage of turnover and the books only supply the
 * turnover figure.
 *
 * Nothing here posts. A computation is a view over the books plus unposted
 * metadata, so it can be recomputed freely and never needs a reversing entry.
 *
 * Every result carries the rate caveat from india-it.ts. CA to verify.
 */

export interface ComputationLine {
  label: string;
  amount_paise: number;
  /** Negative lines (deductions) render as subtractions. */
  subtract?: boolean;
  note?: string;
}

export interface Computation {
  fy: string;
  entity_type: string;
  regime: string;
  presumptive: string;
  /** True when the rates used aren't confirmed for this year. */
  provisional: boolean;
  caveat: string;
  rates_tax_year: string;

  book_profit_paise: number;
  book_depreciation_paise: number;
  it_depreciation_paise: number;
  addbacks_paise: number;
  deductions_paise: number;
  turnover_paise: number;

  lines: ComputationLine[];
  gross_total_income_paise: number;
  taxable_income_paise: number;

  /** Firms only: the most that may be deducted for partner remuneration,
   * measured on net profit as the P&L shows it.
   *
   * Indicative, and NOT auto-applied. Two reasons: the remuneration actually
   * paid is a fact only the office holds, and where remuneration is already
   * debited in the P&L the statute measures the ceiling after adding it back —
   * which this figure cannot see. Silently capping a number the user typed
   * would hide both problems instead of surfacing them. */
  partner_remuneration_ceiling_paise: number | null;

  tax: TaxResult;
  payments_paise: number;
  payments: TaxPaymentRow[];
  net_payable_paise: number; // negative = refund due
  advance_tax: AdvanceTaxInstalment[];
}

/** Debits booked to the depreciation expense account within the FY — what the
 * books charged, which tax law replaces with its own figure. */
function bookDepreciation(db: Database.Database, fy: string): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(jl.debit_paise) - SUM(jl.credit_paise), 0) AS d
       FROM journal_lines jl
       JOIN journals j ON j.id = jl.journal_id
       JOIN accounts a ON a.id = jl.account_id
       WHERE a.code = '5800' AND j.entry_date BETWEEN ? AND ?`
    )
    .get(fyStart(fy), fyEnd(fy)) as { d: number };
  return row.d;
}

export function buildComputation(
  db: Database.Database,
  fy: string
): Computation {
  const settings = db
    .prepare("SELECT * FROM settings WHERE id = 1")
    .get() as SettingsRow;
  const { rates, provisional, caveat } = ratesFor(fy);

  const pnl = profitAndLoss(db, { from: fyStart(fy), to: fyEnd(fy) });
  const adjustments = db
    .prepare("SELECT * FROM it_adjustments WHERE fy = ? ORDER BY id")
    .all(fy) as ItAdjustmentRow[];
  const payments = db
    .prepare("SELECT * FROM tax_payments WHERE fy = ? ORDER BY paid_on, id")
    .all(fy) as TaxPaymentRow[];

  const addbacks = adjustments
    .filter((a) => a.kind === "addback")
    .reduce((s, a) => s + a.amount_paise, 0);
  const deductions = adjustments
    .filter((a) => a.kind === "deduction")
    .reduce((s, a) => s + a.amount_paise, 0);

  const bookDep = bookDepreciation(db, fy);
  const itDep = depreciationSchedule(db, fy).total_depreciation_paise;
  const turnover = pnl.total_income_paise;

  const lines: ComputationLine[] = [];
  let gti: number;

  if (settings.presumptive === "44AD" || settings.presumptive === "44ADA") {
    // Presumptive: income is a percentage of turnover and the books' profit,
    // depreciation and adjustments are all set aside by the scheme.
    const presumed = presumptiveIncome(
      settings.presumptive,
      turnover,
      0, // digital split isn't tracked yet — the higher rate is the safe read
      rates
    );
    lines.push(
      {
        label: `Turnover / gross receipts`,
        amount_paise: turnover,
        note: "from the books",
      },
      {
        label: `Presumptive income under ${settings.presumptive}`,
        amount_paise: presumed,
        note: "flat rate on turnover; book profit and depreciation do not apply",
      }
    );
    gti = presumed;
  } else {
    lines.push({ label: "Net profit as per books", amount_paise: pnl.net_profit_paise });
    if (bookDep !== 0) {
      lines.push({
        label: "Add: depreciation charged in the books",
        amount_paise: bookDep,
        note: "replaced by the Income-tax Act figure below",
      });
    }
    for (const a of adjustments.filter((x) => x.kind === "addback")) {
      lines.push({
        label: `Add: ${a.description}`,
        amount_paise: a.amount_paise,
        note: a.section || undefined,
      });
    }
    if (itDep !== 0) {
      lines.push({
        label: "Less: depreciation as per the Income-tax Act",
        amount_paise: itDep,
        subtract: true,
        note: "block written-down value",
      });
    }
    for (const a of adjustments.filter((x) => x.kind === "deduction")) {
      lines.push({
        label: `Less: ${a.description}`,
        amount_paise: a.amount_paise,
        subtract: true,
        note: a.section || undefined,
      });
    }
    gti = pnl.net_profit_paise + bookDep + addbacks - itDep - deductions;
  }

  // Statutory rounding of total income, then tax on the rounded figure.
  const taxable = roundToTenRupees(Math.max(0, gti));
  const tax = taxFor(taxable, settings.entity_type, settings.it_regime, rates);
  const paid = payments.reduce((s, p) => s + p.amount_paise, 0);

  return {
    fy,
    entity_type: settings.entity_type,
    regime: settings.it_regime,
    presumptive: settings.presumptive,
    provisional,
    caveat,
    rates_tax_year: rates.tax_year,
    book_profit_paise: pnl.net_profit_paise,
    book_depreciation_paise: bookDep,
    it_depreciation_paise: itDep,
    addbacks_paise: addbacks,
    deductions_paise: deductions,
    turnover_paise: turnover,
    lines,
    gross_total_income_paise: gti,
    taxable_income_paise: taxable,
    // On net profit as the P&L shows it. Adding book depreciation back here
    // was wrong — that add-back belongs to the taxable-income bridge, not to
    // the book-profit figure this ceiling is measured on, and it overstated
    // the ceiling by the whole depreciation charge.
    partner_remuneration_ceiling_paise:
      settings.entity_type === "partnership"
        ? partnerRemunerationCeiling(pnl.net_profit_paise, rates)
        : null,
    tax,
    payments_paise: paid,
    payments,
    net_payable_paise: tax.total_tax_paise - paid,
    advance_tax: advanceTaxSchedule(tax.total_tax_paise, rates),
  };
}
