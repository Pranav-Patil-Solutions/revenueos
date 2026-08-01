import type { Book } from "./book";
import { ACCOUNT_GROUPS, DEFAULT_GROUP_BY_TYPE, groupFor, labelForEntity } from "./coa";
import { fyOf, fyStart } from "./fy";
import type {
  AccountType,
  DocumentStatus,
  EntryType,
  PartyKind,
  PartyRow,
  SettingsRow,
} from "./types";

/** Read-model queries for statements, trial balance, P&L, day book, GST
 * filing prep, and the dashboard. All amounts INTEGER paise. Every query is
 * scoped to one company via the Book handle (RVOS-004 P2/P6) — joins are
 * scoped on EVERY table they touch, not just one, so a stray cross-company
 * row can never slip through even if an upstream write ever mis-tagged it. */

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
export function trialBalance(book: Book, asOf?: string): TrialBalance {
  const rows = book.all(
    `SELECT a.code, a.name, a.type,
            COALESCE(SUM(CASE WHEN @asOf IS NULL OR j.entry_date <= @asOf
              THEN jl.debit_paise - jl.credit_paise END), 0) AS net
     FROM accounts a
     LEFT JOIN journal_lines jl ON jl.account_id = a.id AND jl.company_id = @company_id
     LEFT JOIN journals j ON j.id = jl.journal_id AND j.company_id = @company_id
     WHERE a.company_id = @company_id
     GROUP BY a.id
     ORDER BY a.code`,
    { asOf: asOf ?? null }
  ) as {
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
 * are reported as cross_ledger_paise rather than silently dropped.
 *
 * `asOf` (inclusive) limits BOTH ledgers to entries on or before that date —
 * the CA pack's annexure reads FY-end positions this way. Omitted = full
 * history, byte-identical to the pre-asOf behaviour. */
export function partyStatement(
  book: Book,
  partyId: number,
  asOf?: string
): PartyStatement | null {
  const party = book.get(
    "SELECT * FROM parties WHERE id = @partyId AND company_id = @company_id",
    { partyId }
  ) as PartyRow | undefined;
  if (!party) return null;
  const control = party.kind === "customer" ? "1200" : "2100";
  const other = party.kind === "customer" ? "2100" : "1200";
  const rows = book.all(
    `SELECT j.id AS journal_id, j.entry_date, j.entry_type, j.memo, j.ref_no,
            jl.debit_paise, jl.credit_paise
     FROM journal_lines jl
     JOIN journals j ON j.id = jl.journal_id AND j.company_id = @company_id
     JOIN accounts a ON a.id = jl.account_id AND a.company_id = @company_id
     WHERE jl.company_id = @company_id
       AND jl.party_id = @partyId AND a.code = @code
       AND (@asOf IS NULL OR j.entry_date <= @asOf)
     ORDER BY j.entry_date, j.id`,
    { partyId, code: control, asOf: asOf ?? null }
  ) as Omit<StatementLine, "balance_paise">[];

  let balance = 0;
  const lines = rows.map((r) => {
    balance +=
      party.kind === "customer"
        ? r.debit_paise - r.credit_paise
        : r.credit_paise - r.debit_paise;
    return { ...r, balance_paise: balance };
  });

  // AP runs credit-positive, AR debit-positive — sign by the account itself.
  const cross = book.get(
    `SELECT COALESCE(SUM(CASE WHEN a.code = '2100'
              THEN jl.credit_paise - jl.debit_paise
              ELSE jl.debit_paise - jl.credit_paise END), 0) AS net
     FROM journal_lines jl
     JOIN journals j ON j.id = jl.journal_id AND j.company_id = @company_id
     JOIN accounts a ON a.id = jl.account_id AND a.company_id = @company_id
     WHERE jl.company_id = @company_id
       AND jl.party_id = @partyId AND a.code = @code
       AND (@asOf IS NULL OR j.entry_date <= @asOf)`,
    { partyId, code: other, asOf: asOf ?? null }
  ) as { net: number };

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
export function dayBook(book: Book, month?: string): DayBookEntry[] {
  const journals = (
    month
      ? book.all(
          `SELECT * FROM journals
           WHERE company_id = @company_id AND substr(entry_date, 1, 7) = @month
           ORDER BY entry_date, id`,
          { month }
        )
      : book.all(
          `SELECT * FROM journals WHERE company_id = @company_id ORDER BY entry_date, id`
        )
  ) as DayBookEntry[];
  return journals.map((j) => ({
    ...j,
    legs: book.all(
      `SELECT a.code AS account_code, a.name AS account_name,
              jl.debit_paise, jl.credit_paise, p.name AS party_name
       FROM journal_lines jl
       JOIN accounts a ON a.id = jl.account_id AND a.company_id = @company_id
       LEFT JOIN parties p ON p.id = jl.party_id AND p.company_id = @company_id
       WHERE jl.company_id = @company_id AND jl.journal_id = @journalId
       ORDER BY jl.line_no`,
      { journalId: j.id }
    ) as DayBookLeg[],
  }));
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
export function profitAndLoss(book: Book, period?: PnlPeriod): PnlReport {
  const month = typeof period === "string" ? period : null;
  const from = typeof period === "object" ? period.from : null;
  const to = typeof period === "object" ? period.to : null;
  const rows = book.all(
    `SELECT a.code, a.name, a.type,
            COALESCE(SUM(jl.credit_paise), 0) - COALESCE(SUM(jl.debit_paise), 0) AS net_credit
     FROM accounts a
     LEFT JOIN journal_lines jl ON jl.account_id = a.id AND jl.company_id = @company_id
     LEFT JOIN journals j ON j.id = jl.journal_id AND j.company_id = @company_id
     WHERE a.company_id = @company_id
       AND a.type IN ('income', 'expense')
       AND (@month IS NULL OR substr(j.entry_date, 1, 7) = @month)
       AND (@from IS NULL OR (j.entry_date >= @from AND j.entry_date <= @to))
     GROUP BY a.id
     ORDER BY a.code`,
    { month, from, to }
  ) as {
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
  book: Book,
  from: string | null,
  toExclusive: string | null,
  toInclusive: string | null
): number {
  const r = book.get(
    `SELECT COALESCE(SUM(jl.credit_paise), 0) - COALESCE(SUM(jl.debit_paise), 0) AS net
     FROM journal_lines jl
     JOIN journals j ON j.id = jl.journal_id AND j.company_id = @company_id
     JOIN accounts a ON a.id = jl.account_id AND a.company_id = @company_id
     WHERE jl.company_id = @company_id
       AND a.type IN ('income', 'expense')
       AND (@from IS NULL OR j.entry_date >= @from)
       AND (@toExclusive IS NULL OR j.entry_date < @toExclusive)
       AND (@toInclusive IS NULL OR j.entry_date <= @toInclusive)`,
    { from, toExclusive, toInclusive }
  ) as { net: number };
  return r.net;
}

/** Balance sheet as of a date. P&L balances are NEVER posted to equity —
 * retained earnings (prior FYs) and current-year profit are computed here and
 * injected as derived lines in the capital group (post-only books preserved).
 * Throws unless assets = liabilities + equity — the fourth balance guard. */
export function balanceSheet(
  book: Book,
  asOf: string,
  settings: SettingsRow
): BalanceSheetReport {
  const fy = fyOf(asOf);
  const yearStart = fyStart(fy);

  const rows = book.all(
    `SELECT a.code, a.name, a.type, a.group_code,
            COALESCE(SUM(jl.debit_paise), 0) - COALESCE(SUM(jl.credit_paise), 0) AS net
     FROM accounts a
     JOIN journal_lines jl ON jl.account_id = a.id AND jl.company_id = @company_id
     JOIN journals j ON j.id = jl.journal_id AND j.company_id = @company_id
     WHERE a.company_id = @company_id AND j.entry_date <= @asOf
     GROUP BY a.id
     ORDER BY a.code`,
    { asOf }
  ) as {
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
  const retained_prior_paise = netProfitBetween(book, null, yearStart, null);
  const current_year_profit_paise = netProfitBetween(book, yearStart, null, asOf);
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
export function gstr3b(book: Book, month: string): Gstr3bSummary {
  const acc = (codes: string[], types: EntryType[]): number => {
    const codeParams = Object.fromEntries(codes.map((c, i) => [`code${i}`, c]));
    const typeParams = Object.fromEntries(types.map((t, i) => [`type${i}`, t]));
    const r = book.get(
      `SELECT COALESCE(SUM(jl.credit_paise), 0) - COALESCE(SUM(jl.debit_paise), 0) AS net
       FROM journal_lines jl
       JOIN journals j ON j.id = jl.journal_id AND j.company_id = @company_id
       JOIN accounts a ON a.id = jl.account_id AND a.company_id = @company_id
       WHERE jl.company_id = @company_id
         AND substr(j.entry_date, 1, 7) = @month
         AND a.code IN (${codes.map((_, i) => `@code${i}`).join(",")})
         AND j.entry_type IN (${types.map((_, i) => `@type${i}`).join(",")})`,
      { month, ...codeParams, ...typeParams }
    ) as { net: number };
    return r.net;
  };

  const outward: EntryType[] = ["sale", "credit_note"];
  const inward: EntryType[] = ["purchase", "debit_note"];
  const outward_taxable_paise = acc(["4000"], outward);
  const cgst_paise = acc(["2200"], outward);
  const sgst_paise = acc(["2210"], outward);
  const igst_paise = acc(["2220"], outward);
  // ITC is an asset — net debit. `|| 0` normalises the -0 the negation
  // produces on an empty month, which would otherwise print as "-₹0.00".
  const itc_paise = -acc(["1300"], inward) || 0;
  const net_payable_paise = cgst_paise + sgst_paise + igst_paise - itc_paise;
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
export function gstr1B2B(book: Book, month: string): Gstr1B2bRow[] {
  const journals = book.all(
    `SELECT id, entry_date, entry_type, ref_no, memo FROM journals
     WHERE company_id = @company_id
       AND entry_type IN ('sale', 'credit_note') AND substr(entry_date, 1, 7) = @month
     ORDER BY entry_date, id`,
    { month }
  ) as {
    id: number;
    entry_date: string;
    entry_type: EntryType;
    ref_no: string;
    memo: string;
  }[];

  return journals.map((j) => {
    const legs = book.all(
      `SELECT a.code, jl.debit_paise, jl.credit_paise, jl.party_id
       FROM journal_lines jl
       JOIN accounts a ON a.id = jl.account_id AND a.company_id = @company_id
       WHERE jl.company_id = @company_id AND jl.journal_id = @journalId`,
      { journalId: j.id }
    ) as {
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
      ? (book.get(
          "SELECT name, gstin, state_code, kind FROM parties WHERE id = @partyId AND company_id = @company_id",
          { partyId: control.party_id }
        ) as { name: string; gstin: string; state_code: string; kind: PartyKind } | undefined)
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

/** "YYYY-MM" ± n months, as pure string math (fy.ts convention — no Date). */
function stepMonth(month: string, delta: number): string {
  const m = month.match(/^(\d{4})-(\d{2})$/);
  if (!m) throw new Error(`Bad month "${month}" — expected "YYYY-MM"`);
  const mm = Number(m[2]);
  if (mm < 1 || mm > 12) throw new Error(`Bad month "${month}"`);
  const total = Number(m[1]) * 12 + (mm - 1) + delta;
  const year = Math.floor(total / 12);
  const idx = ((total % 12) + 12) % 12;
  return `${year}-${String(idx + 1).padStart(2, "0")}`;
}

export interface TrendPoint {
  month: string;
  closing_paise: number;
}

/** Receivables CLOSING BALANCE at the end of each of the last `count` months
 * ending at `month`. A balance, not a flow: each point carries every entry
 * ever posted up to that month end, so the series ties to the AR control
 * account at every step and its final point is the control total as at
 * `month` end. (The Receivables tile is all-time, so a book carrying
 * future-dated entries will show a tile above the last point — a real
 * difference, deliberately not smoothed away.)
 *
 * Ported onto the Book handle at the RVOS-004/005 merge (RVOS-004 P6's
 * ratchet doesn't see this file — it landed after the ratchet's last scan —
 * so this was scoped by hand, the same way P4/P5 scoped their own new code
 * as they went, rather than left for a ratchet run that would never catch it. */
export function receivablesTrend(
  book: Book,
  month: string,
  count = 4
): TrendPoint[] {
  if (count < 1) throw new Error("receivablesTrend needs count >= 1");
  const months: string[] = [];
  for (let i = count - 1; i >= 0; i--) months.push(stepMonth(month, -i));
  const first = months[0];
  const last = months[months.length - 1];

  const opening = book.get(
    `SELECT COALESCE(SUM(jl.debit_paise), 0) - COALESCE(SUM(jl.credit_paise), 0) AS net
     FROM journal_lines jl
     JOIN accounts a ON a.id = jl.account_id AND a.company_id = @company_id
     JOIN journals j ON j.id = jl.journal_id AND j.company_id = @company_id
     WHERE jl.company_id = @company_id AND a.code = '1200'
       AND substr(j.entry_date, 1, 7) < @first`,
    { first }
  ) as { net: number };

  const rows = book.all(
    `SELECT substr(j.entry_date, 1, 7) AS m,
            COALESCE(SUM(jl.debit_paise), 0) - COALESCE(SUM(jl.credit_paise), 0) AS net
     FROM journal_lines jl
     JOIN accounts a ON a.id = jl.account_id AND a.company_id = @company_id
     JOIN journals j ON j.id = jl.journal_id AND j.company_id = @company_id
     WHERE jl.company_id = @company_id AND a.code = '1200'
       AND substr(j.entry_date, 1, 7) >= @first
       AND substr(j.entry_date, 1, 7) <= @last
     GROUP BY m`,
    { first, last }
  ) as { m: string; net: number }[];

  const delta = new Map(rows.map((r) => [r.m, r.net]));
  let running = opening.net;
  return months.map((m) => {
    running += delta.get(m) ?? 0;
    return { month: m, closing_paise: running };
  });
}

export interface DocumentStatusSlice {
  status: DocumentStatus;
  count: number;
}

/** Document pipeline census, ordered by pipeline stage rather than count, so
 * the legend reads as the workflow does. Statuses with no documents are
 * omitted — an empty slice is noise, not information. Ported onto the Book
 * handle at the RVOS-004/005 merge — see receivablesTrend's comment above. */
export function documentStatusBreakdown(book: Book): DocumentStatusSlice[] {
  const rows = book.all(
    "SELECT status, COUNT(*) AS n FROM documents WHERE company_id = @company_id GROUP BY status"
  ) as { status: DocumentStatus; n: number }[];
  const order: DocumentStatus[] = [
    "posted",
    "extracted",
    "uploaded",
    "extracting",
    "failed",
  ];
  const byStatus = new Map(rows.map((r) => [r.status, r.n]));
  return order
    .filter((s) => (byStatus.get(s) ?? 0) > 0)
    .map((s) => ({ status: s, count: byStatus.get(s) as number }));
}

export function dashboardStats(book: Book, month: string): DashboardStats {
  const ar = book.get(
    `SELECT COALESCE(SUM(jl.debit_paise), 0) - COALESCE(SUM(jl.credit_paise), 0) AS net
     FROM journal_lines jl
     JOIN accounts a ON a.id = jl.account_id AND a.company_id = @company_id
     WHERE jl.company_id = @company_id AND a.code = '1200'`
  ) as { net: number };
  const pending = book.get(
    "SELECT COUNT(*) AS n FROM documents WHERE company_id = @company_id AND status = 'extracted'"
  ) as { n: number };
  const journals = book.get(
    "SELECT COUNT(*) AS n FROM journals WHERE company_id = @company_id AND substr(entry_date, 1, 7) = @month",
    { month }
  ) as { n: number };
  return {
    receivables_paise: ar.net,
    gst_payable_paise: gstr3b(book, month).net_payable_paise,
    pending_review: pending.n,
    journals_this_month: journals.n,
  };
}
