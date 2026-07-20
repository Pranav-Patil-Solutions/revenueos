import type Database from "better-sqlite3";
import { fyEnd, fyLabel, fyStart, fyStartYear, monthsOfFy } from "./fy";
import { monthLabel } from "./format";
import type { ComplianceMarkRow, SettingsRow } from "./types";

/**
 * Compliance calendar — the office's due-date board for GST, TDS and
 * income-tax filings across one FY.
 *
 * The rules generate WHAT is due and WHEN; a human marks each item done or
 * not-applicable, and anything unmarked past its date shows overdue. The
 * engine never reads the clock: `today` is passed in, so a test (or a
 * back-dated review) sees exactly the board the office saw on that day.
 *
 * DUE DATES ARE LAW-ADJACENT: like the rate tables in tax/india-it.ts and
 * tax/tds.ts, every rule ships `verified: false` until its dates are
 * confirmed against the current statute and CBIC/CBDT notifications — due
 * dates get extended by notification often, and this table cannot see that.
 * The board says so on screen.
 */

export type ComplianceRegime = "gst" | "tds" | "it";
export type ComplianceStatus = "done" | "na" | "pending" | "overdue";

export interface ComplianceRule {
  /** Stable identifier — compliance_marks rows key on it. Never rename. */
  code: string;
  label: string;
  regime: ComplianceRegime;
  note: string;
  /** False = the due dates have not been confirmed against the statute. */
  verified: boolean;
  source: string;
}

const UNCONFIRMED =
  "Due dates as commonly published; not confirmed against the current statute or notifications.";

export const RULES: ComplianceRule[] = [
  {
    code: "gstr1",
    label: "GSTR-1",
    regime: "gst",
    note: "Outward supplies for the month, due the 11th of the following month (monthly filers; QRMP differs).",
    verified: false,
    source: UNCONFIRMED,
  },
  {
    code: "gstr3b",
    label: "GSTR-3B",
    regime: "gst",
    note: "Summary return and tax payment for the month, due the 20th of the following month (monthly filers).",
    verified: false,
    source: UNCONFIRMED,
  },
  {
    code: "tds-deposit",
    label: "TDS deposit",
    regime: "tds",
    note: "Deposit the month's deductions by the 7th of the next month; March deductions by 30 April.",
    verified: false,
    source: UNCONFIRMED,
  },
  {
    code: "tds-return",
    label: "TDS return",
    regime: "tds",
    note: "Quarterly statements (26Q/24Q): Q1 by 31 Jul, Q2 by 31 Oct, Q3 by 31 Jan, Q4 by 31 May.",
    verified: false,
    source: UNCONFIRMED,
  },
  {
    code: "advance-tax",
    label: "Advance tax",
    regime: "it",
    note: "Cumulative 15% / 45% / 75% / 100% of the year's tax by 15 Jun, 15 Sep, 15 Dec and 15 Mar.",
    verified: false,
    source: UNCONFIRMED,
  },
  {
    code: "itr",
    label: "Income-tax return",
    regime: "it",
    note: "For the FY just ended: 31 Jul of the assessment year, or 31 Oct when the accounts need audit.",
    verified: false,
    source: UNCONFIRMED,
  },
];

export function complianceRule(code: string): ComplianceRule | undefined {
  return RULES.find((r) => r.code === code);
}

export interface ComplianceItem {
  rule_code: string;
  label: string;
  regime: ComplianceRegime;
  /** The mark key: months are absolute ("2026-04"); quarters and the ITR
   * carry the FY ("2026-27-Q4", "2026-27") so marks never collide across
   * years under UNIQUE(rule_code, period). */
  period: string;
  period_label: string;
  /** What this particular item covers — shown on the board row. */
  detail: string;
  due_date: string; // ISO YYYY-MM-DD
  status: ComplianceStatus;
  /** The mark's note ('' when unmarked). */
  note: string;
  marked_at: string | null;
  verified: boolean;
}

/** "2026-12" → "2027-01". Pure string month math, mirroring fy.ts. */
function nextMonth(month: string): string {
  const m = month.match(/^(\d{4})-(\d{2})$/);
  if (!m) throw new Error(`Bad month "${month}"`);
  const y = Number(m[1]);
  const mo = Number(m[2]);
  if (mo < 1 || mo > 12) throw new Error(`Bad month "${month}"`);
  return mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, "0")}`;
}

type Unmarked = Omit<ComplianceItem, "status" | "note" | "marked_at">;

function bare(
  rule: ComplianceRule,
  period: string,
  period_label: string,
  detail: string,
  due_date: string
): Unmarked {
  return {
    rule_code: rule.code,
    label: rule.label,
    regime: rule.regime,
    period,
    period_label,
    detail,
    due_date,
    verified: rule.verified,
  };
}

const QUARTER_MONTHS = ["Apr–Jun", "Jul–Sep", "Oct–Dec", "Jan–Mar"];

/**
 * Every item an FY can owe, before marks — pure, so the due-date shapes are
 * testable without a db. Regimes the business is not under are skipped
 * entirely (not shown as n/a): a board full of returns the office never
 * files would bury the ones it must.
 */
export function dueItems(
  fy: string,
  applies: { gst: boolean; tds: boolean }
): Unmarked[] {
  const y = fyStartYear(fy);
  const items: Unmarked[] = [];
  const rule = (code: string): ComplianceRule => {
    const r = complianceRule(code);
    if (!r) throw new Error(`Unknown compliance rule "${code}"`);
    return r;
  };

  if (applies.gst) {
    for (const m of monthsOfFy(fy)) {
      items.push(
        bare(rule("gstr1"), m, monthLabel(m), `Outward supplies of ${monthLabel(m)}`, `${nextMonth(m)}-11`),
        bare(rule("gstr3b"), m, monthLabel(m), `Summary return + payment for ${monthLabel(m)}`, `${nextMonth(m)}-20`)
      );
    }
  }

  if (applies.tds) {
    for (const m of monthsOfFy(fy)) {
      // March deductions get until 30 April; every other month the 7th.
      const due = m === `${y + 1}-03` ? `${y + 1}-04-30` : `${nextMonth(m)}-07`;
      items.push(
        bare(rule("tds-deposit"), m, monthLabel(m), `Deposit deductions of ${monthLabel(m)}`, due)
      );
    }
    const returnDues = [`${y}-07-31`, `${y}-10-31`, `${y + 1}-01-31`, `${y + 1}-05-31`];
    for (let q = 1; q <= 4; q++) {
      items.push(
        bare(
          rule("tds-return"),
          `${fy}-Q${q}`,
          `Q${q} ${fyLabel(fy)}`,
          `26Q/24Q statement for ${QUARTER_MONTHS[q - 1]}`,
          returnDues[q - 1]
        )
      );
    }
  }

  const atDues = [`${y}-06-15`, `${y}-09-15`, `${y}-12-15`, `${y + 1}-03-15`];
  const atPct = [15, 45, 75, 100];
  for (let q = 1; q <= 4; q++) {
    items.push(
      bare(
        rule("advance-tax"),
        `${fy}-Q${q}`,
        `Q${q} ${fyLabel(fy)}`,
        `Cumulative ${atPct[q - 1]}% of the year's tax`,
        atDues[q - 1]
      )
    );
  }
  return items;
}

/** ITR for the FY is due in the NEXT year — the assessment year. */
export function itrItem(fy: string, auditCase: boolean): Unmarked {
  const y = fyStartYear(fy);
  const r = complianceRule("itr");
  if (!r) throw new Error('Unknown compliance rule "itr"');
  return bare(
    r,
    fy,
    fyLabel(fy),
    auditCase ? "Return for the FY (audit case)" : "Return for the FY",
    auditCase ? `${y + 1}-10-31` : `${y + 1}-07-31`
  );
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The FY's board: rules → items, merged with compliance_marks. A mark wins
 * outright (done/na, whatever the date); unmarked items derive
 * pending/overdue from `today` — which the CALLER supplies, so the rules
 * stay clock-free.
 *
 * GST rules apply only when a GSTIN is on file. TDS rules apply when a TAN
 * is on file OR the FY already holds deductions — books with real TDS in
 * them owe deposits and returns even before settings catch up.
 */
export function generateItems(
  db: Database.Database,
  fy: string,
  settings: SettingsRow,
  today: string
): ComplianceItem[] {
  if (!ISO_DATE.test(today)) throw new Error(`Bad today "${today}"`);
  const hasTds =
    (
      db
        .prepare("SELECT COUNT(*) AS n FROM tds_entries WHERE entry_date BETWEEN ? AND ?")
        .get(fyStart(fy), fyEnd(fy)) as { n: number }
    ).n > 0;
  const unmarked = [
    ...dueItems(fy, {
      gst: settings.gstin.trim() !== "",
      tds: settings.tan.trim() !== "" || hasTds,
    }),
    itrItem(fy, settings.fy_audit_case === 1),
  ];

  const marks = new Map<string, ComplianceMarkRow>();
  for (const m of db
    .prepare("SELECT * FROM compliance_marks")
    .all() as ComplianceMarkRow[]) {
    marks.set(`${m.rule_code} ${m.period}`, m);
  }

  const ruleOrder = new Map(RULES.map((r, i) => [r.code, i]));
  return unmarked
    .map((item): ComplianceItem => {
      const mark = marks.get(`${item.rule_code} ${item.period}`);
      return {
        ...item,
        status: mark ? mark.status : item.due_date < today ? "overdue" : "pending",
        note: mark?.note ?? "",
        marked_at: mark?.marked_at ?? null,
      };
    })
    .sort(
      (a, b) =>
        a.due_date.localeCompare(b.due_date) ||
        (ruleOrder.get(a.rule_code) ?? 0) - (ruleOrder.get(b.rule_code) ?? 0)
    );
}
