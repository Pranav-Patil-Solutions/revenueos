import { roundHalfUp } from "./india-gst";
import type { EntityType, ItRegime, Presumptive } from "../types";

/**
 * Income tax, India — rate tables and the pure functions over them.
 *
 * EVERY figure here is keyed by TAX YEAR and carries where it came from and
 * whether it has been confirmed. That is deliberate: a wrong rate in this file
 * becomes a wrong return, and the failure is silent — the arithmetic still
 * balances, the page still renders a confident number. So the design rule is
 * that an unconfirmed year must be VISIBLE, never merely assumed:
 *
 *   - `ratesFor()` returns `provisional: true` when the year has no table of
 *     its own and the previous year's had to be carried forward, and every
 *     caller surfaces that. It does NOT silently inherit.
 *   - A year before the earliest table throws rather than guessing backwards.
 *   - No section numbers appear in any output. The Income-tax Act, 2025 took
 *     effect 1 April 2026 — inside the range this code computes — and
 *     renumbered the 1961 Act's sections; available sources disagree on the
 *     new numbering. Section labels would be display metadata anyway and must
 *     never be load-bearing. See HANDOFF.md's P7 pre-flight notes.
 *
 * Money is integer paise throughout. Statutory rounding is to the nearest ₹10.
 *
 * CA to verify — every table below needs confirming against the bare Act for
 * the year being filed before anything here is relied on.
 */

const LAKH = 10_000_000; // paise
const CRORE = 100 * LAKH;

export interface Slab {
  /** Upper bound of the band in paise; null = no ceiling. */
  upto_paise: number | null;
  rate: number; // percent
}

export interface SurchargeTier {
  above_paise: number;
  rate: number; // percent
}

export interface Rebate {
  /** Total income at or below which the rebate applies. */
  limit_paise: number;
  /** Maximum rebate. */
  max_paise: number;
  /** Marginal relief caps tax at (income − limit) just past the limit. */
  marginal_relief: boolean;
}

export interface TaxYearRates {
  tax_year: string; // FY key, e.g. "2026-27"
  /** False = these numbers have NOT been confirmed against the Act. */
  verified: boolean;
  source: string;
  slabs_new: Slab[];
  slabs_old: Slab[];
  rebate_new: Rebate;
  rebate_old: Rebate;
  /** Individual surcharge ladder, highest applicable tier wins. */
  surcharge: SurchargeTier[];
  /** The new regime caps surcharge below the old regime's top tier. */
  surcharge_cap_new: number;
  cess_rate: number;
  firm_rate: number;
  firm_surcharge: SurchargeTier;
  /** Domestic company: normal rate for a small company, and the
   * concessional-election rate with its own flat surcharge. */
  company_rate: number;
  company_concessional_rate: number;
  company_surcharge: SurchargeTier[];
  company_concessional_surcharge: number;
  presumptive_business_rate: number;
  presumptive_business_digital_rate: number;
  presumptive_profession_rate: number;
  /** Partner-remuneration ceiling: the higher of `first_min_paise` or
   * `first_rate`% of the first `first_slab_paise` of book profit, then
   * `balance_rate`% of the rest. */
  partner_remuneration: {
    first_slab_paise: number;
    first_min_paise: number;
    first_rate: number;
    balance_rate: number;
  };
  /** Cumulative advance-tax instalments: [label, cumulative %]. */
  advance_tax: { due: string; cumulative_percent: number }[];
}

/**
 * Rate tables, oldest first.
 *
 * 2026-27 is VERIFIED against fetched official texts (see its `source`).
 * 2025-26 is deliberately left unverified: it is a 1961-Act year assembled
 * from secondary sources, and no one has checked it against that Act's own
 * schedule — computations for it keep their caveat. Flip `verified` ONLY
 * after checking a year against the bare Act/Finance Act text, and put the
 * citation in `source` when you do.
 *
 * Model notes for the verified year (Income-tax Act 2025 + Finance Act 2026):
 * - `surcharge` stores the OLD-regime ladder (10/15/25/37). The new regime's
 *   own ladder has NO 37% tier (FA 2026 s.3(4)(b) Table Sl. 10 tops out at
 *   25%); `surcharge_cap_new: 25` reproduces it exactly, so both regimes
 *   compute correctly from the one ladder.
 * - The 15% surcharge cap on dividend / s.196-198 capital-gains income is
 *   NOT modelled — the app carries no special-rate income.
 * - `company_rate` 25% applies where turnover/gross receipts in the tax year
 *   TWO years prior (for 2026-27: tax year 2024-25) ≤ ₹400 crore; the app
 *   does not model the turnover test and always uses 25%.
 * - Salary standard deduction (₹75,000 new regime / ₹50,000 old — ITA 2025
 *   s.19(1) Sl. 2) is NOT modelled; the app computes business income.
 */
export const TAX_YEARS: TaxYearRates[] = [
  {
    tax_year: "2025-26",
    verified: false,
    source:
      "Budget 2025 new-regime ladder, from secondary sources — UNCONFIRMED, verify against the Act",
    slabs_new: [
      { upto_paise: 4 * LAKH, rate: 0 },
      { upto_paise: 8 * LAKH, rate: 5 },
      { upto_paise: 12 * LAKH, rate: 10 },
      { upto_paise: 16 * LAKH, rate: 15 },
      { upto_paise: 20 * LAKH, rate: 20 },
      { upto_paise: 24 * LAKH, rate: 25 },
      { upto_paise: null, rate: 30 },
    ],
    slabs_old: [
      { upto_paise: 2.5 * LAKH, rate: 0 },
      { upto_paise: 5 * LAKH, rate: 5 },
      { upto_paise: 10 * LAKH, rate: 20 },
      { upto_paise: null, rate: 30 },
    ],
    rebate_new: { limit_paise: 12 * LAKH, max_paise: 60_000 * 100, marginal_relief: true },
    rebate_old: { limit_paise: 5 * LAKH, max_paise: 12_500 * 100, marginal_relief: false },
    surcharge: [
      { above_paise: 50 * LAKH, rate: 10 },
      { above_paise: 1 * CRORE, rate: 15 },
      { above_paise: 2 * CRORE, rate: 25 },
      { above_paise: 5 * CRORE, rate: 37 },
    ],
    surcharge_cap_new: 25,
    cess_rate: 4,
    firm_rate: 30,
    firm_surcharge: { above_paise: 1 * CRORE, rate: 12 },
    company_rate: 25,
    company_concessional_rate: 22,
    company_surcharge: [
      { above_paise: 1 * CRORE, rate: 7 },
      { above_paise: 10 * CRORE, rate: 12 },
    ],
    company_concessional_surcharge: 10,
    presumptive_business_rate: 8,
    presumptive_business_digital_rate: 6,
    presumptive_profession_rate: 50,
    partner_remuneration: {
      first_slab_paise: 6 * LAKH,
      first_min_paise: 3 * LAKH,
      first_rate: 90,
      balance_rate: 60,
    },
    advance_tax: [
      { due: "15 Jun", cumulative_percent: 15 },
      { due: "15 Sep", cumulative_percent: 45 },
      { due: "15 Dec", cumulative_percent: 75 },
      { due: "15 Mar", cumulative_percent: 100 },
    ],
  },
  {
    tax_year: "2026-27",
    verified: true,
    source:
      "Verified 2026-07-21 against fetched official texts: Finance Act 2026 " +
      "(gazette CG-DL-E-31032026-271439, egazette.gov.in/WriteReadData/2026/271439.pdf) " +
      "s.3 + First Schedule Part I-B — charges 'the tax year commencing on the 1st day " +
      "of April, 2026' under the Income-tax Act, 2025; ITA 2025 (Act 30 of 2025, gazette " +
      "265620.pdf) ss.156 (rebate — s.156, not 157), 200–204 (rates), 35(e)(iii) (partner " +
      "remuneration), 58 (presumptive), 408 (advance tax); Budget 2026 Memorandum " +
      "(indiabudget.gov.in/doc/memo.pdf): 'no change proposed in tax rates'. Each figure " +
      "independently re-checked by an adversarial pass against the same gazette texts.",
    slabs_new: [
      { upto_paise: 4 * LAKH, rate: 0 },
      { upto_paise: 8 * LAKH, rate: 5 },
      { upto_paise: 12 * LAKH, rate: 10 },
      { upto_paise: 16 * LAKH, rate: 15 },
      { upto_paise: 20 * LAKH, rate: 20 },
      { upto_paise: 24 * LAKH, rate: 25 },
      { upto_paise: null, rate: 30 },
    ],
    slabs_old: [
      { upto_paise: 2.5 * LAKH, rate: 0 },
      { upto_paise: 5 * LAKH, rate: 5 },
      { upto_paise: 10 * LAKH, rate: 20 },
      { upto_paise: null, rate: 30 },
    ],
    rebate_new: { limit_paise: 12 * LAKH, max_paise: 60_000 * 100, marginal_relief: true },
    rebate_old: { limit_paise: 5 * LAKH, max_paise: 12_500 * 100, marginal_relief: false },
    surcharge: [
      { above_paise: 50 * LAKH, rate: 10 },
      { above_paise: 1 * CRORE, rate: 15 },
      { above_paise: 2 * CRORE, rate: 25 },
      { above_paise: 5 * CRORE, rate: 37 },
    ],
    surcharge_cap_new: 25,
    cess_rate: 4,
    firm_rate: 30,
    firm_surcharge: { above_paise: 1 * CRORE, rate: 12 },
    company_rate: 25,
    company_concessional_rate: 22,
    company_surcharge: [
      { above_paise: 1 * CRORE, rate: 7 },
      { above_paise: 10 * CRORE, rate: 12 },
    ],
    company_concessional_surcharge: 10,
    presumptive_business_rate: 8,
    presumptive_business_digital_rate: 6,
    presumptive_profession_rate: 50,
    partner_remuneration: {
      first_slab_paise: 6 * LAKH,
      first_min_paise: 3 * LAKH,
      first_rate: 90,
      balance_rate: 60,
    },
    advance_tax: [
      { due: "15 Jun", cumulative_percent: 15 },
      { due: "15 Sep", cumulative_percent: 45 },
      { due: "15 Dec", cumulative_percent: 75 },
      { due: "15 Mar", cumulative_percent: 100 },
    ],
  },
];

export interface ResolvedRates {
  rates: TaxYearRates;
  /** True when the year has no table of its own and an earlier one was used. */
  provisional: boolean;
  /** Why the caller should show a warning, or "" when the year is confirmed.
   * Covers ALL groups — callers that used only some should build their own
   * with caveatForGroups() so they do not warn about rates they never read. */
  caveat: string;
  /** Groups of this year's table that nobody has verified. */
  unverified: RateGroup[];
  /** The "no table for this year" note on its own, "" when the year is exact.
   * Callers that scope their own group caveat still need to carry this. */
  provisional_note: string;
}

/**
 * The rates to use for a tax year. Carries the most recent earlier table
 * forward when the year isn't listed — but says so, loudly, rather than
 * letting stale slabs pass as current. Throws for a year before the earliest
 * table, since guessing backwards has no defensible basis.
 */
/**
 * Verification granularity — RVOS-003 P1.
 *
 * `TaxYearRates.verified` is ONE boolean over ~15 fields, and that is not how
 * verification actually happens. The 2026-07-21 adversarial pass cleared the
 * slabs, rebate, surcharge, cess, firm and company rates, s.40(b) and advance
 * tax for FY 2025-26 from gazette text — and explicitly REFUSED the
 * presumptive rates, which rest on search snippets. Flipping the year would
 * claim verification nobody performed; leaving it false warns on figures that
 * ARE confirmed. Both are lies, in opposite directions.
 *
 * So verification is recorded per GROUP, per YEAR. A group ABSENT from a
 * year's map is unverified for that year, and callers name the groups they
 * actually used so a book-profit computation is never warned about
 * presumptive rates it did not touch.
 *
 * NOTE ON `presumptive`: absent for BOTH years, deliberately. The FY 2025-26
 * research could not source the s.44AD/44ADA/44AE deemed-profit percentages
 * beyond search snippets, and I could not establish that the RVOS-002 pass
 * separately confirmed them for FY 2026-27 either — the EVOLUTION #19 record
 * mentions presumptive only in the advance-tax context. Rather than inherit
 * an unexamined claim, both years warn until someone reads the section.
 */
export type RateGroup =
  | "slabs"
  | "rebate"
  | "surcharge"
  | "cess"
  | "firm"
  | "company"
  | "partner_remuneration"
  | "advance_tax"
  | "presumptive";

export const ALL_RATE_GROUPS: RateGroup[] = [
  "slabs",
  "rebate",
  "surcharge",
  "cess",
  "firm",
  "company",
  "partner_remuneration",
  "advance_tax",
  "presumptive",
];

const GROUP_LABELS: Record<RateGroup, string> = {
  slabs: "the slab rates",
  rebate: "the s.87A rebate",
  surcharge: "the surcharge ladder",
  cess: "the cess rate",
  firm: "the firm/LLP rate",
  company: "the company rates",
  partner_remuneration: "the s.40(b) partner-remuneration ceiling",
  advance_tax: "the advance-tax schedule",
  presumptive: "the presumptive rates (s.44AD/44ADA/44AE)",
};

const FA2026 = "Finance Act 2026 (gazette CG-DL-E-31032026-271439)";
const FA2025 = "Finance Act 2025 (gazette CG-DL-E-29032025-262125)";

/** group → citation. Absent group = NOT verified for that year. */
const RATE_VERIFICATION: Record<string, Partial<Record<RateGroup, string>>> = {
  "2025-26": {
    slabs: `${FA2025} s.25 inserting s.115BAC(1A)(iii) (new regime); ${FA2026} Sch. I Part I-A Para A(I) (old regime). AY 2026-27 = FY 2025-26.`,
    rebate: `${FA2025} s.20 amending the s.87A proviso — ₹12,00,000 / ₹60,000 with marginal relief (new regime); ₹5,00,000 / ₹12,500 without (old).`,
    surcharge: `${FA2026} Sch. I Part I-A Para F Table 1 (old regime 10/15/25/37); s.2(4)(b) Table Sl.10 caps the new regime at 25% — there is NO 37% tier under s.115BAC(1A).`,
    cess: `${FA2026} s.2(6) — 4% on income-tax plus surcharge.`,
    firm: `${FA2026} Sch. I Part I-A Para C (30%) and Para F Table 1 Sl.4 (12% above ₹1 crore).`,
    company: `${FA2026} Sch. I Part I-A Para E.I — 25% only where turnover in PY 2023-24 ≤ ₹400 crore, else 30%. The app does NOT model the turnover test and always applies 25%.`,
    partner_remuneration: `Finance (No. 2) Act 2024 s.14 (gazette CG-DL-E-16082024-256436) — NOT Finance Act 2025. In force from AY 2025-26, so it covers FY 2025-26.`,
    advance_tax: `Income-tax Act 1961 s.211(1) and clause (b) — 15/45/75/100%, presumptive assessees one instalment by 15 Mar. The s.211(1) proviso treats anything paid by 31 March as advance tax for that year.`,
  },
  "2026-27": {
    slabs: `Income-tax Act 2025 + ${FA2026} Sch. I Part I-B. Verified 2026-07-21 (EVOLUTION #19).`,
    rebate: `Income-tax Act 2025 s.156 rebate. Verified 2026-07-21 (EVOLUTION #19).`,
    surcharge: `${FA2026} surcharge tables. Verified 2026-07-21 (EVOLUTION #19).`,
    cess: `${FA2026} — 4% health and education cess. Verified 2026-07-21.`,
    firm: `${FA2026} firm/LLP rate and surcharge. Verified 2026-07-21.`,
    company: `${FA2026} company rates. The turnover test is not modelled — always 25%. Verified 2026-07-21.`,
    partner_remuneration: `s.40(b) equivalent under the Income-tax Act 2025. Verified 2026-07-21.`,
    advance_tax: `Income-tax Act 2025 s.408(1) and s.408(2) (presumptive single instalment). Verified 2026-07-21.`,
  },
};

/** The citation for a group in a year, or null when nobody has verified it. */
export function groupSource(taxYear: string, group: RateGroup): string | null {
  return RATE_VERIFICATION[taxYear]?.[group] ?? null;
}

/** Which of the named groups are unverified for this year. */
export function unverifiedGroups(
  taxYear: string,
  groups: RateGroup[] = ALL_RATE_GROUPS
): RateGroup[] {
  return groups.filter((g) => groupSource(taxYear, g) === null);
}

/**
 * A caveat naming ONLY the unverified groups among those the caller used.
 * "" when everything it relied on is confirmed — so a verified computation
 * renders clean rather than carrying a warning about rates it never touched.
 */
export function caveatForGroups(taxYear: string, groups: RateGroup[]): string {
  const missing = unverifiedGroups(taxYear, groups);
  if (missing.length === 0) return "";
  const names = missing.map((g) => GROUP_LABELS[g]);
  const list =
    names.length === 1
      ? names[0]
      : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  // Phrased without a verb so it cannot disagree with a plural group label
  // ("the presumptive rates ... has not been" was the first draft).
  return (
    `For ${taxYear}, ${list} — NOT confirmed against the Act. ` +
    `Verify before filing from these figures.`
  );
}

export function ratesFor(taxYear: string): ResolvedRates {
  const exact = TAX_YEARS.find((t) => t.tax_year === taxYear);
  const chosen =
    exact ??
    [...TAX_YEARS].reverse().find((t) => t.tax_year < taxYear) ??
    null;
  if (!chosen) {
    throw new Error(
      `No income-tax rates on file for ${taxYear} or any earlier year — add a table to india-it.ts before computing.`
    );
  }
  const provisional = !exact;
  const notes: string[] = [];
  if (provisional) {
    notes.push(
      `No rate table for ${taxYear}: computed using ${chosen.tax_year} rates. Confirm this year's rates before filing.`
    );
  }
  const groupCaveat = caveatForGroups(chosen.tax_year, ALL_RATE_GROUPS);
  if (groupCaveat) notes.push(groupCaveat);
  return {
    rates: chosen,
    provisional,
    caveat: notes.join(" "),
    unverified: unverifiedGroups(chosen.tax_year),
    provisional_note: provisional ? notes[0] : "",
  };
}

/** Statutory rounding: to the nearest ₹10. */
export function roundToTenRupees(paise: number): number {
  const sign = paise < 0 ? -1 : 1;
  return sign * roundHalfUp(Math.abs(paise) / 1000) * 1000;
}

/** Tax on an amount across a slab ladder. */
export function slabTax(taxablePaise: number, slabs: Slab[]): number {
  if (taxablePaise <= 0) return 0;
  let tax = 0;
  let floor = 0;
  for (const s of slabs) {
    const ceiling = s.upto_paise ?? Infinity;
    const band = Math.min(taxablePaise, ceiling) - floor;
    if (band > 0) tax += (band * s.rate) / 100;
    floor = ceiling;
    if (taxablePaise <= ceiling) break;
  }
  return roundHalfUp(tax);
}

/**
 * Surcharge with marginal relief: crossing a threshold must never cost more in
 * extra tax than the extra income earned.
 *
 * The ceiling is the FULL liability at the threshold — tax plus whatever
 * surcharge already applied just below it — not the bare slab tax. At the
 * second threshold and above, surcharge is already running at the previous
 * tier's rate, so pricing the ceiling without it over-grants relief massively
 * and total tax can *fall* as income rises. Hence the recursion: the liability
 * at a threshold is itself computed with relief, one tier down. It terminates
 * because tiers apply strictly above their bound, so at exactly `above_paise`
 * only lower tiers can match.
 *
 * `taxBeforeSurcharge` prices tax at any income on the same basis as the
 * caller (post-rebate for an individual, flat rate for a firm or company), so
 * the ceiling and the actual liability are always measured the same way.
 */
export function surchargeWithRelief(
  totalIncomePaise: number,
  taxBeforeSurcharge: (incomePaise: number) => number,
  tiers: SurchargeTier[],
  capRate: number | null
): { surcharge_paise: number; marginal_relief_paise: number } {
  const tier = [...tiers]
    .sort((a, b) => a.above_paise - b.above_paise)
    .filter((t) => totalIncomePaise > t.above_paise)
    .pop();
  if (!tier) return { surcharge_paise: 0, marginal_relief_paise: 0 };

  const rate = capRate === null ? tier.rate : Math.min(tier.rate, capRate);
  const tax = taxBeforeSurcharge(totalIncomePaise);
  const gross = roundHalfUp((tax * rate) / 100);

  const atThreshold = surchargeWithRelief(
    tier.above_paise,
    taxBeforeSurcharge,
    tiers,
    capRate
  );
  const liabilityAtThreshold =
    taxBeforeSurcharge(tier.above_paise) + atThreshold.surcharge_paise;
  const ceiling = liabilityAtThreshold + (totalIncomePaise - tier.above_paise);

  const relief = Math.max(0, tax + gross - ceiling);
  const capped = Math.max(0, gross - relief);
  return {
    surcharge_paise: capped,
    marginal_relief_paise: gross - capped,
  };
}

export interface TaxResult {
  taxable_paise: number;
  tax_before_rebate_paise: number;
  rebate_paise: number;
  surcharge_paise: number;
  surcharge_marginal_relief_paise: number;
  cess_paise: number;
  total_tax_paise: number;
  basis: string;
}

/** Individual (proprietorship) — slabs, rebate with marginal relief, then
 * surcharge and cess. */
export function taxForIndividual(
  taxablePaise: number,
  regime: ItRegime,
  rates: TaxYearRates
): TaxResult {
  const isNew = regime === "new";
  const slabs = isNew ? rates.slabs_new : rates.slabs_old;
  const rebateRule = isNew ? rates.rebate_new : rates.rebate_old;

  /** Slab tax less any rebate, at any income — the basis surcharge sits on. */
  const afterRebateAt = (income: number): number => {
    const t = slabTax(income, slabs);
    if (income <= rebateRule.limit_paise) {
      return t - Math.min(t, rebateRule.max_paise);
    }
    if (rebateRule.marginal_relief) {
      // Just past the limit, tax cannot exceed the income earned beyond it.
      return Math.min(t, income - rebateRule.limit_paise);
    }
    return t;
  };

  const base = slabTax(taxablePaise, slabs);
  const afterRebate = afterRebateAt(taxablePaise);
  const rebate = base - afterRebate;

  const { surcharge_paise, marginal_relief_paise } = surchargeWithRelief(
    taxablePaise,
    afterRebateAt,
    rates.surcharge,
    isNew ? rates.surcharge_cap_new : null
  );
  const cess = roundHalfUp(
    ((afterRebate + surcharge_paise) * rates.cess_rate) / 100
  );
  return {
    taxable_paise: taxablePaise,
    tax_before_rebate_paise: base,
    rebate_paise: rebate,
    surcharge_paise,
    surcharge_marginal_relief_paise: marginal_relief_paise,
    cess_paise: cess,
    total_tax_paise: roundToTenRupees(afterRebate + surcharge_paise + cess),
    basis: `Individual, ${isNew ? "new" : "old"} regime`,
  };
}

/** Partnership firm / LLP — flat rate, one surcharge threshold. */
export function taxForFirm(
  taxablePaise: number,
  rates: TaxYearRates
): TaxResult {
  const flatTax = (income: number): number =>
    roundHalfUp((Math.max(0, income) * rates.firm_rate) / 100);
  const base = flatTax(taxablePaise);
  const { surcharge_paise, marginal_relief_paise } = surchargeWithRelief(
    taxablePaise,
    flatTax,
    [rates.firm_surcharge],
    null
  );
  const cess = roundHalfUp(((base + surcharge_paise) * rates.cess_rate) / 100);
  return {
    taxable_paise: taxablePaise,
    tax_before_rebate_paise: base,
    rebate_paise: 0,
    surcharge_paise,
    surcharge_marginal_relief_paise: marginal_relief_paise,
    cess_paise: cess,
    total_tax_paise: roundToTenRupees(base + surcharge_paise + cess),
    basis: `Firm at ${rates.firm_rate}%`,
  };
}

/**
 * Domestic company. `concessional` elects the lower rate (which carries its
 * own flat surcharge and gives up most incentives) instead of the normal rate.
 */
export function taxForCompany(
  taxablePaise: number,
  concessional: boolean,
  rates: TaxYearRates
): TaxResult {
  const rate = concessional
    ? rates.company_concessional_rate
    : rates.company_rate;
  const flatTax = (income: number): number =>
    roundHalfUp((Math.max(0, income) * rate) / 100);
  const base = flatTax(taxablePaise);

  let surcharge = 0;
  let relief = 0;
  if (concessional) {
    // Flat, with no threshold — so no marginal relief to compute.
    surcharge = roundHalfUp(
      (base * rates.company_concessional_surcharge) / 100
    );
  } else {
    const s = surchargeWithRelief(
      taxablePaise,
      flatTax,
      rates.company_surcharge,
      null
    );
    surcharge = s.surcharge_paise;
    relief = s.marginal_relief_paise;
  }
  const cess = roundHalfUp(((base + surcharge) * rates.cess_rate) / 100);
  return {
    taxable_paise: taxablePaise,
    tax_before_rebate_paise: base,
    rebate_paise: 0,
    surcharge_paise: surcharge,
    surcharge_marginal_relief_paise: relief,
    cess_paise: cess,
    total_tax_paise: roundToTenRupees(base + surcharge + cess),
    basis: `Domestic company at ${rate}%${concessional ? " (concessional election)" : ""}`,
  };
}

/** Tax for the book's entity type. For a company, `regime === "new"` is read
 * as electing the concessional rate — the settings model has one regime flag
 * and this is what it means for a company. */
export function taxFor(
  taxablePaise: number,
  entity: EntityType,
  regime: ItRegime,
  rates: TaxYearRates
): TaxResult {
  switch (entity) {
    case "partnership":
      return taxForFirm(taxablePaise, rates);
    case "company":
      return taxForCompany(taxablePaise, regime === "new", rates);
    case "proprietorship":
      return taxForIndividual(taxablePaise, regime, rates);
  }
}

/** Presumptive income: a percentage of turnover instead of actual profit.
 * `digitalReceiptsPaise` gets the lower business rate. */
export function presumptiveIncome(
  scheme: Presumptive,
  turnoverPaise: number,
  digitalReceiptsPaise: number,
  rates: TaxYearRates
): number {
  if (scheme === "") return 0;
  if (scheme === "44ADA") {
    return roundHalfUp(
      (turnoverPaise * rates.presumptive_profession_rate) / 100
    );
  }
  const digital = Math.min(Math.max(0, digitalReceiptsPaise), turnoverPaise);
  const cash = turnoverPaise - digital;
  return (
    roundHalfUp((digital * rates.presumptive_business_digital_rate) / 100) +
    roundHalfUp((cash * rates.presumptive_business_rate) / 100)
  );
}

/** The most a firm may deduct for partner remuneration, given book profit. */
export function partnerRemunerationCeiling(
  bookProfitPaise: number,
  rates: TaxYearRates
): number {
  const r = rates.partner_remuneration;
  if (bookProfitPaise <= 0) return r.first_min_paise;
  const first = Math.min(bookProfitPaise, r.first_slab_paise);
  const balance = Math.max(0, bookProfitPaise - r.first_slab_paise);
  const onFirst = Math.max(
    r.first_min_paise,
    roundHalfUp((first * r.first_rate) / 100)
  );
  return onFirst + roundHalfUp((balance * r.balance_rate) / 100);
}

export interface AdvanceTaxInstalment {
  due: string;
  cumulative_percent: number;
  cumulative_paise: number;
  instalment_paise: number;
}

/** Cumulative advance-tax instalments for a net liability. */
export function advanceTaxSchedule(
  netTaxPaise: number,
  rates: TaxYearRates,
  // Presumptive (s.58, old 44AD/44ADA) assessees pay the WHOLE amount in one
  // instalment by 15 March — ITA 2025 s.408(2), verified 2026-07-21.
  presumptive = false
): AdvanceTaxInstalment[] {
  const rows = presumptive
    ? rates.advance_tax.slice(-1)
    : rates.advance_tax;
  let paid = 0;
  return rows.map((a) => {
    const cumulative = roundToTenRupees(
      (Math.max(0, netTaxPaise) * a.cumulative_percent) / 100
    );
    const instalment = cumulative - paid;
    paid = cumulative;
    return {
      due: a.due,
      cumulative_percent: a.cumulative_percent,
      cumulative_paise: cumulative,
      instalment_paise: instalment,
    };
  });
}
