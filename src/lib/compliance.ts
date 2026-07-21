import type Database from "better-sqlite3";
import { fyEnd, fyLabel, fyStart, fyStartYear, monthsOfFy } from "./fy";
import { monthLabel } from "./format";
import type { ComplianceMarkRow, EntityType, SettingsRow } from "./types";

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

export const RULES: ComplianceRule[] = [
  {
    code: "gstr1",
    label: "GSTR-1",
    regime: "gst",
    note: "Outward supplies for the month, due the 11th of the following month (monthly filers; QRMP files quarterly by the 13th). Since Jul 2025 a return cannot be filed more than 3 years after its due date; corrections flow through GSTR-1A.",
    verified: true,
    source:
      "GST portal (tutorial.gst.gov.in, GSTR-1 FAQ) — monthly filers, 11th of the succeeding month; unchanged by the Apr-2026 GST changes. Verified 2026-07-21.",
  },
  {
    code: "gstr3b",
    label: "GSTR-3B",
    regime: "gst",
    note: "Summary return and tax payment for the month, due the 20th of the following month (monthly filers; QRMP 22nd/24th). Auto-populated outward liability is locked since the Jul-2025 period — fix errors in GSTR-1A before filing.",
    verified: true,
    source:
      "GST portal (tutorial.gst.gov.in, GSTR-3B FAQ) — monthly 20th. Verified 2026-07-21.",
  },
  {
    code: "tds-deposit",
    label: "TDS deposit",
    regime: "tds",
    note: "Deposit the month's deductions by the 7th of the next month; March deductions by 30 April (non-government deductors).",
    verified: true,
    source:
      "Income-tax Rules 2026 r.218(2) (CBDT Notification 22/2026 / G.S.R. 198(E), 20 Mar 2026, in force 1 Apr 2026). Verified 2026-07-21.",
  },
  {
    code: "tds-return",
    label: "TDS return",
    regime: "tds",
    note: "Quarterly statements — from FY 2026-27 filed on Form 140 (old 26Q) / Form 138 (old 24Q): Q1 by 31 Jul, Q2 by 31 Oct, Q3 by 31 Jan, Q4 by 31 May.",
    verified: true,
    source:
      "Income-tax Rules 2026 r.219(4) (Notification 22/2026) — 31 Jul / 31 Oct / 31 Jan / 31 May; forms renumbered 26Q→140, 24Q→138. Verified 2026-07-21.",
  },
  {
    code: "advance-tax",
    label: "Advance tax",
    regime: "it",
    note: "Cumulative 15% / 45% / 75% / 100% of the year's tax by 15 Jun, 15 Sep, 15 Dec and 15 Mar. Presumptive (s.58) assessees pay the whole amount by 15 Mar — the board shows only that instalment when a presumptive scheme is set.",
    verified: true,
    source:
      "ITA 2025 s.408(1) (four instalments) and s.408(2) (presumptive single instalment); liability from ₹10,000 (s.404). Verified 2026-07-21.",
  },
  {
    code: "itr",
    label: "Income-tax return",
    regime: "it",
    note: "For the FY just ended: 31 Oct for companies and audit cases; 31 Aug for business/professional non-audit filers (ITR-3/4, from tax year 2026-27); 31 Jul otherwise — the board shows the earlier applicable date where the class is uncertain.",
    verified: true,
    source:
      "ITA 2025 s.263(1) as amended by Finance Act 2026 (s.263(1)(c) added the 31 Aug business/professional non-audit tier). Extensions by notification are not tracked. Verified 2026-07-21.",
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

/**
 * ITR for the FY is due in the NEXT year. Due-date tiers (s.263(1) as
 * amended by FA 2026): companies and audit cases 31 Oct; a proprietorship's
 * business return (ITR-3/4) 31 Aug from tax year 2026-27; everything else —
 * including a partnership's non-audit ITR-5, whose entitlement to the 31 Aug
 * tier is NOT pinned by the verification — the earlier, safe 31 Jul.
 */
export function itrItem(
  fy: string,
  auditCase: boolean,
  entityType: EntityType = "proprietorship"
): Unmarked {
  const y = fyStartYear(fy);
  const r = complianceRule("itr");
  if (!r) throw new Error('Unknown compliance rule "itr"');
  const audit = auditCase || entityType === "company";
  const due = audit
    ? `${y + 1}-10-31`
    : entityType === "proprietorship" && y >= 2026
      ? `${y + 1}-08-31`
      : `${y + 1}-07-31`;
  return bare(
    r,
    fy,
    fyLabel(fy),
    audit ? "Return for the FY (company / audit case)" : "Return for the FY",
    due
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
    itrItem(fy, settings.fy_audit_case === 1, settings.entity_type),
  ].filter(
    // Presumptive (s.58) assessees owe ONE advance-tax instalment, 15 Mar —
    // the Q1–Q3 rows would be false obligations on their board (s.408(2)).
    (i) =>
      !(
        settings.presumptive !== "" &&
        i.rule_code === "advance-tax" &&
        !i.period.endsWith("Q4")
      )
  );

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
