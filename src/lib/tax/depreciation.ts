import type Database from "better-sqlite3";
import { fyEnd, fyKey, fyStart, fyStartYear } from "../fy";
import { roundHalfUp } from "./india-gst";
import type { BlockCode, FixedAssetRow } from "../types";

/**
 * Income-tax depreciation, India — the WDV *block* method of s.32.
 *
 * The unit of depreciation is the BLOCK, never the individual asset: every
 * asset of a given rate pools together, additions go in at cost, disposals
 * come out at their sale proceeds, and one rate is applied to what remains.
 * Individual assets are tracked only to compute those movements (and to give
 * the office a register to look at).
 *
 * Two rules drive the arithmetic:
 *  - HALF-YEAR RULE: an asset put to use for fewer than 180 days in the year
 *    gets half the block rate, for that year only.
 *  - The block cannot go negative. Sale proceeds are capped at the block's
 *    value; once a block is emptied, depreciation for the year is nil.
 *
 * All integer paise. Nothing here reads or writes journals — posting is
 * postDepreciationEntry() in actions.ts, which books ONE entry per FY.
 *
 * CA to verify: these are the common IT-Act block rates, not a substitute for
 * a professional's read of the client's asset schedule.
 */

export interface ItBlock {
  code: BlockCode;
  label: string;
  rate: number; // percent, applied to the block's written-down value
  /** The seed COA account this block's cost sits in (see SEED_ACCOUNTS). */
  account_code: string;
}

/** Frozen alongside the block CHECK on fixed_assets / wdv_openings. */
export const IT_BLOCKS: ItBlock[] = [
  { code: "building", label: "Buildings", rate: 10, account_code: "1520" },
  { code: "furniture", label: "Furniture & fixtures", rate: 10, account_code: "1510" },
  { code: "plant", label: "Plant & machinery", rate: 15, account_code: "1500" },
  { code: "vehicles", label: "Vehicles", rate: 15, account_code: "1540" },
  { code: "computers", label: "Computers", rate: 40, account_code: "1530" },
];

export function blockFor(code: string): ItBlock | undefined {
  return IT_BLOCKS.find((b) => b.code === code);
}

/** The half-year rule's threshold: fewer than this many days in use during
 * the FY halves the rate. */
export const HALF_YEAR_DAYS = 180;

export interface BlockWdv {
  fy: string;
  block: BlockCode;
  rate: number;
  opening_paise: number;
  /** Additions in use for >= 180 days — full rate. */
  additions_full_paise: number;
  /** Additions in use for < 180 days — half rate. */
  additions_half_paise: number;
  /** Sale proceeds, capped at what the block was worth. */
  disposals_paise: number;
  depreciation_paise: number;
  closing_paise: number;
  /** True when the opening came from a wdv_openings override rather than
   * from last year's closing. */
  opening_overridden: boolean;
}

const MS_PER_DAY = 86_400_000;

/** Days an asset is in use during the FY, counting both end days. Date-only
 * strings are read as UTC midnights, so this is plain calendar arithmetic
 * with no timezone or DST component. */
export function daysInUse(putToUseIso: string, fy: string): number {
  const end = fyEnd(fy);
  const start = putToUseIso > fyStart(fy) ? putToUseIso : fyStart(fy);
  if (start > end) return 0;
  return Math.round((utc(end) - utc(start)) / MS_PER_DAY) + 1;
}

function utc(iso: string): number {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) throw new Error(`Bad ISO date "${iso}"`);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/** One FY's movement for one block, given the opening it starts from. */
function stepYear(
  assets: FixedAssetRow[],
  fy: string,
  block: ItBlock,
  openingPaise: number,
  openingOverridden: boolean
): BlockWdv {
  const from = fyStart(fy);
  const to = fyEnd(fy);

  let additions_full_paise = 0;
  let additions_half_paise = 0;
  let proceeds = 0;
  for (const a of assets) {
    if (a.put_to_use_date && a.put_to_use_date >= from && a.put_to_use_date <= to) {
      if (daysInUse(a.put_to_use_date, fy) >= HALF_YEAR_DAYS) {
        additions_full_paise += a.cost_paise;
      } else {
        additions_half_paise += a.cost_paise;
      }
    }
    // Only assets that actually ENTERED the block can leave it. An asset
    // bought but never put to use never had its cost added, so letting its
    // sale proceeds out would shrink the block — and cut the depreciation of
    // every other asset in it — against a cost that was never there.
    if (
      a.disposed_date &&
      a.disposed_date >= from &&
      a.disposed_date <= to &&
      a.put_to_use_date &&
      a.put_to_use_date <= to
    ) {
      proceeds += a.disposal_paise ?? 0;
    }
  }

  // Proceeds cannot take the block below zero — the excess is a capital gain
  // (out of v1 scope), not negative depreciation.
  const pool = openingPaise + additions_full_paise + additions_half_paise;
  const disposals_paise = Math.min(proceeds, pool);

  // Disposals come off the full-rate pool first; only the remainder touches
  // the half-rate additions.
  const fullPool = openingPaise + additions_full_paise;
  const fromFull = Math.min(disposals_paise, fullPool);
  const fullBase = fullPool - fromFull;
  const halfBase = additions_half_paise - (disposals_paise - fromFull);

  const depreciation_paise =
    roundHalfUp((fullBase * block.rate) / 100) +
    roundHalfUp((halfBase * block.rate) / 200);

  return {
    fy,
    block: block.code,
    rate: block.rate,
    opening_paise: openingPaise,
    additions_full_paise,
    additions_half_paise,
    disposals_paise,
    depreciation_paise,
    closing_paise: fullBase + halfBase - depreciation_paise,
    opening_overridden: openingOverridden,
  };
}

/**
 * A block's schedule for one FY. The opening is a wdv_openings override when
 * one exists, otherwise last year's closing — so the books roll forward year
 * on year from whichever FY the office first entered.
 *
 * Rolled forward iteratively (not recursively) from the earliest FY that has
 * any asset or override, so the depth is the number of years of history.
 */
export function blockWdv(
  db: Database.Database,
  fy: string,
  block: ItBlock
): BlockWdv {
  const assets = db
    .prepare("SELECT * FROM fixed_assets WHERE block = ? ORDER BY id")
    .all(block.code) as FixedAssetRow[];
  const overrides = new Map(
    (
      db
        .prepare("SELECT fy, opening_paise FROM wdv_openings WHERE block = ?")
        .all(block.code) as { fy: string; opening_paise: number }[]
    ).map((o) => [o.fy, o.opening_paise])
  );

  const target = fyStartYear(fy);
  const first = earliestYear(assets, overrides, target);

  let opening = 0;
  let result: BlockWdv | null = null;
  for (let y = first; y <= target; y++) {
    const key = fyKey(y);
    const override = overrides.get(key);
    const overridden = override !== undefined;
    if (overridden) opening = override;
    result = stepYear(assets, key, block, opening, overridden);
    opening = result.closing_paise;
  }
  // Nothing on record at or before the requested FY — an empty block.
  return result ?? stepYear([], fy, block, 0, false);
}

/** The first FY worth rolling from: the earliest override or asset date, but
 * never later than the FY being asked for. */
function earliestYear(
  assets: FixedAssetRow[],
  overrides: Map<string, number>,
  target: number
): number {
  const years: number[] = [];
  for (const key of overrides.keys()) years.push(fyStartYear(key));
  for (const a of assets) {
    for (const d of [a.put_to_use_date, a.disposed_date]) {
      if (d) years.push(fyStartYear(fyKeyOf(d)));
    }
  }
  if (years.length === 0) return target;
  return Math.min(Math.min(...years), target);
}

/** ISO date → FY key, local to this module to avoid importing fyOf's
 * today-dependent siblings. */
function fyKeyOf(iso: string): string {
  const year = Number(iso.slice(0, 4));
  const month = Number(iso.slice(5, 7));
  return fyKey(month >= 4 ? year : year - 1);
}

/** The FY's depreciation journal if one is already posted. One entry per year
 * is the rule; with post-only books a second would need a manual reversal to
 * undo, so both the page and the posting action gate on this. */
export function postedDepreciation(
  db: Database.Database,
  fy: string
): { id: number; entry_date: string; amount_paise: number } | undefined {
  // The amount comes off the 5800 charge itself, so the caller can tell when
  // the register has moved since the books were written.
  return db
    .prepare(
      `SELECT j.id, j.entry_date,
              COALESCE(SUM(jl.debit_paise), 0) AS amount_paise
       FROM journals j
       JOIN journal_lines jl ON jl.journal_id = j.id
       JOIN accounts a ON a.id = jl.account_id AND a.code = '5800'
       WHERE j.entry_type = 'depreciation' AND j.entry_date BETWEEN ? AND ?
       GROUP BY j.id
       ORDER BY j.id LIMIT 1`
    )
    .get(fyStart(fy), fyEnd(fy)) as
    | { id: number; entry_date: string; amount_paise: number }
    | undefined;
}

export interface DepreciationSchedule {
  fy: string;
  blocks: BlockWdv[];
  total_depreciation_paise: number;
  total_closing_paise: number;
}

/** Every block's schedule for an FY, plus the totals the journal posts. */
export function depreciationSchedule(
  db: Database.Database,
  fy: string
): DepreciationSchedule {
  const blocks = IT_BLOCKS.map((b) => blockWdv(db, fy, b));
  return {
    fy,
    blocks,
    total_depreciation_paise: blocks.reduce(
      (sum, b) => sum + b.depreciation_paise,
      0
    ),
    total_closing_paise: blocks.reduce((sum, b) => sum + b.closing_paise, 0),
  };
}
