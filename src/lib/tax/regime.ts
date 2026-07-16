/**
 * Pluggable tax-regime seam. Settings carry country/currency; the active
 * regime module implements this interface. India GST is the only v1 pack —
 * add a new module (e.g. eu-vat.ts) and switch on settings.country to go
 * international. All amounts are INTEGER minor units (paise); every split
 * must preserve the integer sum exactly.
 */
export interface TaxSplit {
  taxablePaise: number;
  taxPaise: number;
  grossPaise: number;
}

export interface TaxRegime {
  /** Stable identifier, e.g. "in-gst". */
  code: string;
  /** ISO country this regime applies to, e.g. "IN". */
  country: string;
  /** Permitted rates (percent). */
  rates: readonly number[];
  /** Split a tax-inclusive gross into taxable + tax. gross is always exact. */
  splitInclusive(grossPaise: number, rate: number): TaxSplit;
  /** Add tax on top of a taxable amount. */
  splitExclusive(taxablePaise: number, rate: number): TaxSplit;
}
