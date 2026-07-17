/**
 * Pure date-fill/validation logic for the review grid, extracted out of
 * review-table.tsx so it's testable without a DOM (see EVOLUTION.md #8 —
 * findings 1-3 of the post-ship code review). Keep this framework-free.
 */

export interface DateRow {
  entry_date: string;
  include: boolean;
  row_no: number;
}

/**
 * Bulk-fill a document-level date onto every INCLUDED row that's missing one.
 * Excluded/unchecked rows are left untouched on purpose: a bulk fill must
 * never fabricate a date that later gets persisted (and possibly posted) if
 * the row is re-included down the line. Returns the original array reference
 * unchanged when fillDate is blank, so callers can skip a redundant setState.
 */
export function fillEmptyDates<T extends DateRow>(
  rows: readonly T[],
  fillDate: string
): T[] {
  if (!fillDate) return rows as T[];
  return rows.map((r) =>
    r.include && !r.entry_date ? { ...r, entry_date: fillDate } : r
  );
}

/** Count of included rows missing a date — drives the "N rows missing a date" banner. */
export function countEmptyDates(rows: readonly DateRow[]): number {
  return rows.filter((r) => r.include && !r.entry_date).length;
}

/** Indices of included rows missing a date, for the pre-post validation gate. */
export function findMissingDateIndices(rows: readonly DateRow[]): number[] {
  return rows.flatMap((r, i) => (r.include && !r.entry_date ? [i] : []));
}

/**
 * Live "Row N needs a date" banner text, derived from the current
 * missing-date index set and row numbers. Recompute this on every render
 * (e.g. via useMemo keyed on both arguments) instead of freezing a string
 * once at click time, so it shrinks in place as clearDateFlag() resolves rows.
 */
export function missingDatesText(
  rows: readonly DateRow[],
  missing: ReadonlySet<number>
): string | null {
  if (missing.size === 0) return null;
  const nums = [...missing].sort((a, b) => a - b).map((i) => rows[i].row_no);
  const many = nums.length > 1;
  return `Row${many ? "s" : ""} ${nums.join(", ")} need${many ? "" : "s"} a date before posting — fill the highlighted date cell${many ? "s" : ""}.`;
}
