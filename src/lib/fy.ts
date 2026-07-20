import type Database from "better-sqlite3";
import { todayIso } from "./format";

/**
 * Indian financial year (April–March) as pure string math — no Date
 * arithmetic, no timezone surprises. An FY is keyed "2026-27" meaning
 * 1 Apr 2026 … 31 Mar 2027.
 */

const FY_RE = /^(\d{4})-(\d{2})$/;

function startYearOf(fy: string): number {
  const m = fy.match(FY_RE);
  if (!m) throw new Error(`Bad FY key "${fy}" — expected e.g. "2026-27"`);
  const start = Number(m[1]);
  if (Number(m[2]) !== (start + 1) % 100) {
    throw new Error(`Bad FY key "${fy}" — suffix must be start year + 1`);
  }
  return start;
}

/** Start calendar year of an FY key: "2026-27" → 2026. Validates the key. */
export function fyStartYear(fy: string): number {
  return startYearOf(fy);
}

/** FY key for a start year: 2026 → "2026-27". */
export function fyKey(startYear: number): string {
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`;
}

/** ISO date → FY key. "2026-03-31" → "2025-26"; "2026-04-01" → "2026-27". */
export function fyOf(iso: string): string {
  const m = iso.match(/^(\d{4})-(\d{2})/);
  if (!m) throw new Error(`Bad ISO date "${iso}"`);
  const year = Number(m[1]);
  const month = Number(m[2]);
  return fyKey(month >= 4 ? year : year - 1);
}

/** First day of the FY: "2026-27" → "2026-04-01". */
export function fyStart(fy: string): string {
  return `${startYearOf(fy)}-04-01`;
}

/** Last day of the FY: "2026-27" → "2027-03-31". */
export function fyEnd(fy: string): string {
  return `${startYearOf(fy) + 1}-03-31`;
}

/** FY containing today (local time). */
export function currentFy(): string {
  return fyOf(todayIso());
}

/** Display label: "2026-27" → "FY 2026-27". */
export function fyLabel(fy: string): string {
  return `FY ${fyKey(startYearOf(fy))}`;
}

/** The 12 months of an FY as "YYYY-MM": Apr … Mar. */
export function monthsOfFy(fy: string): string[] {
  const start = startYearOf(fy);
  const months: string[] = [];
  for (let i = 0; i < 12; i++) {
    const month = ((3 + i) % 12) + 1; // Apr=4 … Dec=12, Jan=1 … Mar=3
    const year = month >= 4 ? start : start + 1;
    months.push(`${year}-${String(month).padStart(2, "0")}`);
  }
  return months;
}

/** FY quarter of an ISO date: Apr–Jun 1, Jul–Sep 2, Oct–Dec 3, Jan–Mar 4. */
export function quarterOf(iso: string): 1 | 2 | 3 | 4 {
  const m = iso.match(/^\d{4}-(\d{2})/);
  if (!m) throw new Error(`Bad ISO date "${iso}"`);
  const month = Number(m[1]);
  if (month < 1 || month > 12) throw new Error(`Bad ISO date "${iso}"`);
  return (Math.floor(((month + 8) % 12) / 3) + 1) as 1 | 2 | 3 | 4;
}

/** FYs the books span (earliest journal → current FY), newest first.
 * Always contains at least the current FY, so selects never render empty. */
export function fyList(db: Database.Database): string[] {
  const row = db
    .prepare("SELECT MIN(entry_date) AS min FROM journals")
    .get() as { min: string | null };
  const last = startYearOf(currentFy());
  const first = row.min ? Math.min(startYearOf(fyOf(row.min)), last) : last;
  const list: string[] = [];
  for (let y = last; y >= first; y--) list.push(fyKey(y));
  return list;
}
