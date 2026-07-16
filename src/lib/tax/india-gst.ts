import type { TaxRegime, TaxSplit } from "./regime";

/**
 * India GST pack — pure integer-paise math, no I/O.
 *
 * splitInclusive uses the complement method: taxable is rounded, tax is the
 * remainder, so taxable + tax always equals the gross exactly and journals
 * built from it balance by construction.
 */

export const GST_RATES = [0, 5, 12, 18, 28] as const;

export function roundHalfUp(x: number): number {
  return Math.floor(x + 0.5);
}

export function splitInclusive(grossPaise: number, rate: number): TaxSplit {
  assertRate(rate);
  const taxablePaise = roundHalfUp((grossPaise * 100) / (100 + rate));
  return { taxablePaise, taxPaise: grossPaise - taxablePaise, grossPaise };
}

export function splitExclusive(taxablePaise: number, rate: number): TaxSplit {
  assertRate(rate);
  const taxPaise = roundHalfUp((taxablePaise * rate) / 100);
  return { taxablePaise, taxPaise, grossPaise: taxablePaise + taxPaise };
}

/** Intra-state tax splits into equal central + state halves; SGST is computed
 * by subtraction so the pair always sums back to the tax exactly. */
export function splitCgstSgst(taxPaise: number): {
  cgstPaise: number;
  sgstPaise: number;
} {
  const cgstPaise = roundHalfUp(taxPaise / 2);
  return { cgstPaise, sgstPaise: taxPaise - cgstPaise };
}

/** IGST applies only when both state codes are known and differ. Missing
 * state codes fall back to intra-state (CGST + SGST). */
export function isInterState(
  partyStateCode: string,
  companyStateCode: string
): boolean {
  return (
    partyStateCode !== "" &&
    companyStateCode !== "" &&
    partyStateCode !== companyStateCode
  );
}

function assertRate(rate: number): void {
  if (!GST_RATES.includes(rate as (typeof GST_RATES)[number])) {
    throw new Error(`invalid GST rate: ${rate}`);
  }
}

export const indiaGst: TaxRegime = {
  code: "in-gst",
  country: "IN",
  rates: GST_RATES,
  splitInclusive,
  splitExclusive,
};
