import type { AccountType, EntityType } from "./types";

/**
 * Chart-of-accounts grouping — static metadata keyed by accounts.group_code.
 * Groups place accounts on a statement (balance sheet vs P&L), give the
 * balance sheet its sections and ordering, and carry the entity-conditional
 * capital label. Not a parent_id tree: one flat group per account.
 */

export type StatementKind = "bs" | "pnl";
export type GroupSection =
  | "assets"
  | "liabilities"
  | "equity"
  | "income"
  | "expense";

export interface AccountGroup {
  code: string;
  label: string;
  statement: StatementKind;
  section: GroupSection;
  order: number; // display order within the statement
}

export const ACCOUNT_GROUPS: AccountGroup[] = [
  { code: "fixed_assets", label: "Fixed assets", statement: "bs", section: "assets", order: 10 },
  { code: "current_assets", label: "Current assets", statement: "bs", section: "assets", order: 20 },
  { code: "capital", label: "Capital account", statement: "bs", section: "equity", order: 30 },
  { code: "current_liabilities", label: "Current liabilities", statement: "bs", section: "liabilities", order: 40 },
  { code: "duties_taxes", label: "Duties & taxes", statement: "bs", section: "liabilities", order: 50 },
  { code: "income", label: "Income", statement: "pnl", section: "income", order: 60 },
  { code: "direct_expenses", label: "Direct expenses", statement: "pnl", section: "expense", order: 70 },
  { code: "indirect_expenses", label: "Indirect expenses", statement: "pnl", section: "expense", order: 80 },
];

export function groupFor(groupCode: string): AccountGroup | undefined {
  return ACCOUNT_GROUPS.find((g) => g.code === groupCode);
}

/** Fallback group for accounts created without one (or pre-grouping rows
 * that somehow escaped the seed backfill). */
export const DEFAULT_GROUP_BY_TYPE: Record<AccountType, string> = {
  asset: "current_assets",
  liability: "current_liabilities",
  equity: "capital",
  income: "income",
  expense: "indirect_expenses",
};

/** account code → group code for every seeded account (the original 13 and
 * the RVOS-002 additions). seedCoreData uses this to backfill live books. */
export const SEED_GROUPS: Record<string, string> = {
  "1000": "current_assets",
  "1100": "current_assets",
  "1200": "current_assets",
  "1300": "duties_taxes",
  "1500": "fixed_assets",
  "1510": "fixed_assets",
  "1520": "fixed_assets",
  "1530": "fixed_assets",
  "1540": "fixed_assets",
  "1590": "fixed_assets",
  "2100": "current_liabilities",
  "2200": "duties_taxes",
  "2210": "duties_taxes",
  "2220": "duties_taxes",
  "2300": "duties_taxes",
  "3000": "capital",
  "3100": "capital",
  "3150": "capital",
  "4000": "income",
  "5000": "direct_expenses",
  "5800": "indirect_expenses",
  "5900": "indirect_expenses",
  "5950": "indirect_expenses",
};

/** Group label adjusted for the entity type — only capital changes:
 * proprietor's capital vs partners' capital vs share capital. */
export function labelForEntity(
  groupCode: string,
  entity: EntityType
): string {
  const group = groupFor(groupCode);
  if (!group) return groupCode;
  if (group.code !== "capital") return group.label;
  switch (entity) {
    case "partnership":
      return "Partners' capital";
    case "company":
      return "Share capital";
    default:
      return "Capital account";
  }
}
