import type Database from "better-sqlite3";
import { ACCOUNT_GROUPS, DEFAULT_GROUP_BY_TYPE, groupFor, labelForEntity } from "./coa";
import { fyOf, fyStart } from "./fy";
import type {
  AccountType,
  EntryType,
  PartyKind,
  PartyRow,
  SettingsRow,
} from "./types";

/** Read-model queries for statements, trial balance, P&L, day book, GST
 * filing prep, and the dashboard. All amounts INTEGER paise. */

export interface TrialBalanceLine {
  code: string;
  name: string;
  type: AccountType;
  debit_paise: number;
  credit_paise: number;
}

export interface TrialBalance {
  lines: TrialBalanceLine[];
  total_debit_paise: number;
  total_credit_paise: number;
  balanced: true;
}

/** Net balance per account on its natural side, optionally as of a date
 * (inclusive). Throws if the books don't sum to zero — the last of the three
 * balance-invariant layers. */
export function trialBalance(
  db: Database.Database,
  asOf?: string
): TrialBalance {
  const rows = db
    .prepare(
      `SELECT a.code, a.name, a.type,
              COALESCE(SUM(CASE WHEN @asOf IS NULL OR j.entry_date <= @asOf
                THEN jl.debit_paise - jl.credit_paise END), 0) AS net
       FROM accounts a
       LEFT JOIN journal_lines jl ON jl.account_id = a.id
       LEFT JOIN journals j ON j.id = jl.journal_id
       GROUP BY a.id
       ORDER BY a.code`
    )
    .all({ asOf: asOf ?? null }) as {
    code: string;
    name: string;
    type: AccountType;
    net: number;
  }[];

  const lines: TrialBalanceLine[] = rows
    .filter((r) => r.net !== 0)
    .map((r) => ({
      code: r.code,
      name: r.name,
      type: r.type,
      debit_paise: r.net > 0 ? r.net : 0,
      credit_paise: r.net < 0 ? -r.net : 0,
    }));
  const total_debit_paise = lines.reduce((s, l) => s + l.debit_paise, 0);
  const total_credit_paise = lines.reduce((s, l) => s + l.credit_paise, 0);
  if (total_debit_paise !== total_credit_paise) {
    throw new Error(
      `TRIAL BALANCE OUT OF BALANCE: Dr ${total_debit_paise} ≠ Cr ${total_credit_paise} paise`
    );
  }
  return { lines, total_debit_paise, total_credit_paise, balanced: true };
}

export interface StatementLine {
  journal_id: number;
  entry_date: string;
  entry_type: EntryType;
  memo: string;
  ref_no: string;
  debit_paise: number;
  credit_paise: number;
  balance_paise: number;
}

export interface PartyStatement {
  party: PartyRow;
  lines: StatementLine[];
  closing_paise: number;
  /** Balance this party carries on the OTHER control account (a customer's
   * payables, a supplier's receivables) — cross-trade and refund entry types
   * post there, and hiding it would misstate who owes whom. */
  cross_ledger_paise: number;
  /** closing − cross: the true net position with this party. */
  net_position_paise: number;
}

/** Control-account movements for one party with a running balance. Customers
 * run on AR (debit balance = they owe us); suppliers on AP (credit balance =
 * we owe them). Legs the same party carries on the other control account
 * (purchases/payments in a customer khata, sales/receipts in a supplier one)
 * are reported as cross_ledger_paise rather than silently dropped. */
export function partyStatement(
  db: Database.Database,
  partyId: number
): PartyStatement | null {
  const party = db
    .prepare("SELECT * FROM parties WHERE id = ?")
    .get(partyId) as PartyRow | undefined;
  if (!party) return null;
  const control = party.kind === "customer" ? "1200" : "2100";
  const other = party.kind === "customer" ? "2100" : "1200";
  const rows = db
    .prepare(
      `SELECT j.id AS journal_id, j.entry_date, j.entry_type, j.memo, j.ref_no,
              jl.debit_paise, jl.credit_paise
       FROM journal_lines jl
       JOIN journals j ON j.id = jl.journal_id
       JOIN accounts a ON a.id = jl.account_id
       WHERE jl.party_id = ? AND a.code = ?
       ORDER BY j.entry_date, j.id`
    )
    .all(partyId, control) as Omit<StatementLine, "balance_paise">[];

  let balance = 0;
  const lines = rows.map((r) => {
    balance +=
      party.kind === "customer"
        ? r.debit_paise - r.credit_paise
        : r.credit_paise - r.debit_paise;
    return { ...r, balance_paise: balance };
  });

  // AP runs credit-positive, AR debit-positive — sign by the account itself.
  const cross = db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN a.code = '2100'
                THEN jl.credit_paise - jl.debit_paise
                ELSE jl.debit_paise - jl.credit_paise END), 0) AS net
       FROM journal_lines jl
       JOIN accounts a ON a.id = jl.account_id
       WHERE jl.party_id = ? AND a.code = ?`
    )
    .get(partyId, other) as { net: number };

  return {
    party,
    lines,
    closing_paise: balance,
    cross_ledger_paise: cross.net,
    net_position_paise: balance - cross.net,
  };
}

export interface DayBookLeg {
  account_code: string;
  account_name: string;
  debit_paise: number;
  credit_paise: number;
  party_name: string | null;
}

export interface DayBookEntry {
  id: number;
  entry_date: string;
  entry_type: EntryType;
  memo: string;
  ref_no: string;
  source_document_id: number | null;
  legs: DayBookLeg[];
}

/** Every journal in date order with its legs. Month filter optional. */
export function dayBook(
  db: Database.Database,
  month?: string
): DayBookEntry[] {
  const journals = (
    month
      ? db
          .prepare(
            `SELECT * FROM journals WHERE substr(entry_date, 1, 7) = ? ORDER BY entry_date, id`
          )
          .all(month)
      : db.prepare(`SELECT * FROM journals ORDER BY entry_date, id`).all()
  ) as DayBookEntry[];
  const legsFor = db.prepare(
    `SELECT a.code AS account_code, a.name AS account_name,
            jl.debit_paise, jl.credit_paise, p.name AS party_name
     FROM journal_lines jl
     JOIN accounts a ON a.id = jl.account_id
     LEFT JOIN parties p ON p.id = jl.party_id
     WHERE jl.journal_id = ?
     ORDER BY jl.line_no`
  );
  return journals.map((j) => ({ ...j, legs: legsFor.all(j.id) as DayBookLeg[] }));
}

export interface PnlReport {
  income_lines: { code: string; name: string; amount_paise: number }[];
  expense_lines: { code: string; name: string; amount_paise: number }[];
  total_income_paise: number;
  total_expense_paise: number;
  net_profit_paise: number;
}

/** P&L period: a month "YYYY-MM" (back-compat) or an inclusive date range
 * (used for FY windows). Omit for all time. */
export type PnlPeriod = string | { from: string; to: string };

/** Income (net credit) vs expenses (net debit) over an optional period. */
export function profitAndLoss(
  db: Database.Database,
  period?: PnlPeriod
): PnlReport {
  const month = typeof period === "string" ? period : null;
  const from = typeof period === "object" ? period.from : null;
  const to = typeof period === "object" ? period.to : null;
  const rows = db
    .prepare(
      `SELECT a.code, a.name, a.type,
              COALESCE(SUM(jl.credit_paise), 0) - COALESCE(SUM(jl.debit_paise), 0) AS net_credit
       FROM accounts a
       LEFT JOIN journal_lines jl ON jl.account_id = a.id
       LEFT JOIN journals j ON j.id = jl.journal_id
       WHERE a.type IN ('income', 'expense')
         AND (@month IS NULL OR substr(j.entry_date, 1, 7) = @month)
         AND (@from IS NULL OR (j.entry_date >= @from AND j.entry_date <= @to))
       GROUP BY a.id
       ORDER BY a.code`
    )
    .all({ month, from, to }) as {
    code: string;
    name: string;
    type: AccountType;
    net_credit: number;
  }[];

  const income_lines = rows
    .filter((r) => r.type === "income" && r.net_credit !== 0)
    .map((r) => ({ code: r.code, name: r.name, amount_paise: r.net_credit }));
  const expense_lines = rows
    .filter((r) => r.type === "expense" && r.net_credit !== 0)
    .map((r) => ({ code: r.code, name: r.name, amount_paise: -r.net_credit }));
  const total_income_paise = income_lines.reduce((s, l) => s + l.amount_paise, 0);
  const total_expense_paise = expense_lines.reduce((s, l) => s + l.amount_paise, 0);
  return {
    income_lines,
    expense_lines,
    total_income_paise,
    total_expense_paise,
    net_profit_paise: total_income_paise - total_expense_paise,
  };
}

export interface BalanceSheetLine {
  code: string;
  name: string;
  amount_paise: number; // debit-positive in asset groups, credit-positive elsewhere
}

export interface BalanceSheetGroup {
  group_code: string;
  label: string;
  section: "assets" | "liabilities" | "equity";
  lines: BalanceSheetLine[];
  total_paise: number;
}

export interface BalanceSheetReport {
  as_of: string;
  fy: string; // FY containing as_of — the current-year-profit window
  groups: BalanceSheetGroup[]; // statement order
  total_assets_paise: number;
  total_liabilities_paise: number;
  total_equity_paise: number;
  retained_prior_paise: number;
  current_year_profit_paise: number;
  balanced: true;
}

/** Net P&L (income − expense) for an inclusive entry-date window. */
function netProfitBetween(
  db: Database.Database,
  from: string | null,
  toExclusive: string | null,
  toInclusive: string | null
): number {
  const r = db
    .prepare(
      `SELECT COALESCE(SUM(jl.credit_paise), 0) - COALESCE(SUM(jl.debit_paise), 0) AS net
       FROM journal_lines jl
       JOIN journals j ON j.id = jl.journal_id
       JOIN accounts a ON a.id = jl.account_id
       WHERE a.type IN ('income', 'expense')
         AND (@from IS NULL OR j.entry_date >= @from)
         AND (@toExclusive IS NULL OR j.entry_date < @toExclusive)
         AND (@toInclusive IS NULL OR j.entry_date <= @toInclusive)`
    )
    .get({ from, toExclusive, toInclusive }) as { net: number };
  return r.net;
}

/** Balance sheet as of a date. P&L balances are NEVER posted to equity —
 * retained earnings (prior FYs) and current-year profit are computed here and
 * injected as derived lines in the capital group (post-only books preserved).
 * Throws unless assets = liabilities + equity — the fourth balance guard. */
export function balanceSheet(
  db: Database.Database,
  asOf: string,
  settings: SettingsRow
): BalanceSheetReport {
  const fy = fyOf(asOf);
  const yearStart = fyStart(fy);

  const rows = db
    .prepare(
      `SELECT a.code, a.name, a.type, a.group_code,
              COALESCE(SUM(jl.debit_paise), 0) - COALESCE(SUM(jl.credit_paise), 0) AS net
       FROM accounts a
       JOIN journal_lines jl ON jl.account_id = a.id
       JOIN journals j ON j.id = jl.journal_id
       WHERE j.entry_date <= ?
       GROUP BY a.id
       ORDER BY a.code`
    )
    .all(asOf) as {
    code: string;
    name: string;
    type: AccountType;
    group_code: string | null;
    net: number;
  }[];

  const groups = new Map<string, BalanceSheetGroup>();
  const groupOf = (groupCode: string): BalanceSheetGroup => {
    let g = groups.get(groupCode);
    if (!g) {
      const meta = groupFor(groupCode);
      if (!meta || meta.statement !== "bs") {
        throw new Error(`Account group "${groupCode}" is not a balance-sheet group`);
      }
      g = {
        group_code: groupCode,
        label: labelForEntity(groupCode, settings.entity_type),
        section: meta.section as "assets" | "liabilities" | "equity",
        lines: [],
        total_paise: 0,
      };
      groups.set(groupCode, g);
    }
    return g;
  };

  for (const r of rows) {
    if (r.type === "income" || r.type === "expense") continue; // rolls into profit
    if (r.net === 0) continue;
    const g = groupOf(r.group_code ?? DEFAULT_GROUP_BY_TYPE[r.type]);
    // Assets display debit-positive; liabilities & equity credit-positive.
    const amount = g.section === "assets" ? r.net : -r.net;
    g.lines.push({ code: r.code, name: r.name, amount_paise: amount });
    g.total_paise += amount;
  }

  // Derived equity: cumulative P&L through FY start, then FY-to-asOf.
  const retained_prior_paise = netProfitBetween(db, null, yearStart, null);
  const current_year_profit_paise = netProfitBetween(db, yearStart, null, asOf);
  if (retained_prior_paise !== 0 || current_year_profit_paise !== 0) {
    const capital = groupOf("capital");
    if (retained_prior_paise !== 0) {
      capital.lines.push({
        code: "",
        name: "Retained earnings (prior years)",
        amount_paise: retained_prior_paise,
      });
      capital.total_paise += retained_prior_paise;
    }
    if (current_year_profit_paise !== 0) {
      capital.lines.push({
        code: "",
        name: "Current year profit",
        amount_paise: current_year_profit_paise,
      });
      capital.total_paise += current_year_profit_paise;
    }
  }

  const ordered = ACCOUNT_GROUPS.filter((g) => groups.has(g.code)).map(
    (g) => groups.get(g.code)!
  );
  const sum = (section: BalanceSheetGroup["section"]): number =>
    ordered
      .filter((g) => g.section === section)
      .reduce((s, g) => s + g.total_paise, 0);
  const total_assets_paise = sum("assets");
  const total_liabilities_paise = sum("liabilities");
  const total_equity_paise = sum("equity");

  if (total_assets_paise !== total_liabilities_paise + total_equity_paise) {
    throw new Error(
      `BALANCE SHEET OUT OF BALANCE as of ${asOf}: assets ${total_assets_paise} ≠ ` +
        `liabilities ${total_liabilities_paise} + equity ${total_equity_paise} paise`
    );
  }

  return {
    as_of: asOf,
    fy,
    groups: ordered,
    total_assets_paise,
    total_liabilities_paise,
    total_equity_paise,
    retained_prior_paise,
    current_year_profit_paise,
    balanced: true,
  };
}

export interface Gstr3bSummary {
  month: string;
  outward_taxable_paise: number;
  cgst_paise: number;
  sgst_paise: number;
  igst_paise: number;
  itc_paise: number;
  net_payable_paise: number;
}

/** GSTR-3B table 3.1-style summary: outward supplies net of credit notes,
 * ITC net of debit notes, and the resulting cash payable. */
export function gstr3b(db: Database.Database, month: string): Gstr3bSummary {
  const acc = (codes: string[], types: EntryType[]): number => {
    const r = db
      .prepare(
        `SELECT COALESCE(SUM(jl.credit_paise), 0) - COALESCE(SUM(jl.debit_paise), 0) AS net
         FROM journal_lines jl
         JOIN journals j ON j.id = jl.journal_id
         JOIN accounts a ON a.id = jl.account_id
         WHERE substr(j.entry_date, 1, 7) = ?
           AND a.code IN (${codes.map(() => "?").join(",")})
           AND j.entry_type IN (${types.map(() => "?").join(",")})`
      )
      .get(month, ...codes, ...types) as { net: number };
    return r.net;
  };

  const outward: EntryType[] = ["sale", "credit_note"];
  const inward: EntryType[] = ["purchase", "debit_note"];
  const outward_taxable_paise = acc(["4000"], outward);
  const cgst_paise = acc(["2200"], outward);
  const sgst_paise = acc(["2210"], outward);
  const igst_paise = acc(["2220"], outward);
  const itc_paise = -acc(["1300"], inward); // ITC is an asset — net debit
  const net_payable_paise =
    cgst_paise + sgst_paise + igst_paise - itc_paise;
  return {
    month,
    outward_taxable_paise,
    cgst_paise,
    sgst_paise,
    igst_paise,
    itc_paise,
    net_payable_paise,
  };
}

export interface Gstr1B2bRow {
  journal_id: number;
  entry_date: string;
  doc_type: "Invoice" | "Credit note";
  ref_no: string;
  memo: string;
  party_name: string;
  party_gstin: string;
  party_state_code: string;
  taxable_paise: number;
  cgst_paise: number;
  sgst_paise: number;
  igst_paise: number;
  gross_paise: number;
}

/** GSTR-1 B2B-style rows: one line per outward document (sale or credit
 * note) in the month, with its taxable value and tax split. */
export function gstr1B2B(db: Database.Database, month: string): Gstr1B2bRow[] {
  const journals = db
    .prepare(
      `SELECT id, entry_date, entry_type, ref_no, memo FROM journals
       WHERE entry_type IN ('sale', 'credit_note') AND substr(entry_date, 1, 7) = ?
       ORDER BY entry_date, id`
    )
    .all(month) as {
    id: number;
    entry_date: string;
    entry_type: EntryType;
    ref_no: string;
    memo: string;
  }[];

  const legFor = db.prepare(
    `SELECT a.code, jl.debit_paise, jl.credit_paise, jl.party_id
     FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
     WHERE jl.journal_id = ?`
  );
  const partyFor = db.prepare(
    "SELECT name, gstin, state_code, kind FROM parties WHERE id = ?"
  );

  return journals.map((j) => {
    const legs = legFor.all(j.id) as {
      code: string;
      debit_paise: number;
      credit_paise: number;
      party_id: number | null;
    }[];
    // Amounts read magnitude-wise so invoices and credit notes both display
    // positive; doc_type carries the direction.
    const amt = (code: string): number => {
      const l = legs.filter((x) => x.code === code);
      return l.reduce((s, x) => s + Math.abs(x.credit_paise - x.debit_paise), 0);
    };
    const control = legs.find((x) => x.code === "1200" && x.party_id !== null);
    const party = control?.party_id
      ? (partyFor.get(control.party_id) as {
          name: string;
          gstin: string;
          state_code: string;
          kind: PartyKind;
        })
      : null;
    return {
      journal_id: j.id,
      entry_date: j.entry_date,
      doc_type: j.entry_type === "sale" ? "Invoice" : "Credit note",
      ref_no: j.ref_no,
      memo: j.memo,
      party_name: party?.name ?? "—",
      party_gstin: party?.gstin ?? "",
      party_state_code: party?.state_code ?? "",
      taxable_paise: amt("4000"),
      cgst_paise: amt("2200"),
      sgst_paise: amt("2210"),
      igst_paise: amt("2220"),
      gross_paise: amt("1200"),
    };
  });
}

export interface DashboardStats {
  receivables_paise: number;
  gst_payable_paise: number;
  pending_review: number;
  journals_this_month: number;
}

export function dashboardStats(
  db: Database.Database,
  month: string
): DashboardStats {
  const ar = db
    .prepare(
      `SELECT COALESCE(SUM(jl.debit_paise), 0) - COALESCE(SUM(jl.credit_paise), 0) AS net
       FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
       WHERE a.code = '1200'`
    )
    .get() as { net: number };
  const pending = db
    .prepare("SELECT COUNT(*) AS n FROM documents WHERE status = 'extracted'")
    .get() as { n: number };
  const journals = db
    .prepare(
      "SELECT COUNT(*) AS n FROM journals WHERE substr(entry_date, 1, 7) = ?"
    )
    .get(month) as { n: number };
  return {
    receivables_paise: ar.net,
    gst_payable_paise: gstr3b(db, month).net_payable_paise,
    pending_review: pending.n,
    journals_this_month: journals.n,
  };
}
