import type { Book } from "./book";
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

/**
 * Year-specific authority.
 *
 * The DUE DATES above are the same for FY 2025-26 and FY 2026-27, but the law
 * behind them is not, and neither are the form numbers. FY 2025-26 is a
 * 1961-Act year: TDS deposits run on Rule 30 of the 1962 Rules, statements are
 * filed on 26Q/24Q under Rule 31A, advance tax is s.211 and the return is
 * s.139(1). From FY 2026-27 all of that is the Income-tax Act 2025 and the
 * Income-tax Rules 2026, with 26Q/24Q renumbered to Form 140/138.
 *
 * RULES above holds the CURRENT (FY 2026-27) authority. This table holds the
 * older one. Rendering the 2026-27 citation on an FY 2025-26 board would cite
 * an Act that did not govern the year — the numbers would be right and the
 * authority wrong, which is the harder error to notice.
 *
 * Everything here ships `verified: false`: the FY 2025-26 research is recorded
 * in RVOS-003-P1-FINDINGS.md but has NOT yet cleared its adversarial re-check.
 * Flags flip only after it does (EVOLUTION #19).
 */
interface PriorAuthority {
  /** Governs FYs up to and including this one. */
  upto_fy: string;
  /** Earliest FY this wording is true for. Omitted = any earlier year.
   * The ITR entry NEEDS this: its 31 Aug tier and FA 2026 s.5 citation came
   * into existence for AY 2026-27 (= FY 2025-26) and asserting them for, say,
   * FY 2020-21 would cite a law that did not yet exist — the same
   * right-date-wrong-authority defect this table was built to remove. */
  from_fy?: string;
  note: string;
  verified: boolean;
  source: string;
  /** Return-form names for that year, where they differ. */
  forms?: string;
}

const PRIOR_AUTHORITIES: Record<string, PriorAuthority> = {
  "tds-deposit": {
    upto_fy: "2025-26",
    note: "Deposit the month's deductions by the 7th of the next month; March deductions by 30 April (non-government deductors).",
    verified: true,
    source:
      "Income-tax Rules 1962 r.30(2) — non-government deductors: 7 days from month end, March credits 30 April. Verified 2026-07-21 against gazette text and independently re-checked by an adversarial pass.",
  },
  "tds-return": {
    upto_fy: "2025-26",
    note: "Quarterly statements on Form 26Q (non-salary) / 24Q (salary): Q1 by 31 Jul, Q2 by 31 Oct, Q3 by 31 Jan, Q4 by 31 May. The Rules-2026 renumbering to Form 140/138 applies from FY 2026-27, NOT to this year.",
    verified: true,
    source:
      "Income-tax Rules 1962 r.31A(2) — one date per quarter for all deductors since the 2016 harmonisation: 31 Jul / 31 Oct / 31 Jan / 31 May. Verified 2026-07-21, adversarially re-checked (the pass caught a search result serving the obsolete pre-2016 table). FORM NAMES rest on the e-filing portal rather than gazette text: the portal scopes the renumbered quarterly forms to tax year 2026-27, leaving 26Q/24Q correct for all four quarters of FY 2025-26.",
    forms: "26Q/24Q",
  },
  "advance-tax": {
    upto_fy: "2025-26",
    note: "Cumulative 15% / 45% / 75% / 100% of the year's tax by 15 Jun, 15 Sep, 15 Dec and 15 Mar. Presumptive (s.44AD/44ADA) assessees pay the whole amount by 15 Mar.",
    verified: true,
    source:
      "Income-tax Act 1961 s.211(1)(a); presumptive (s.44AD/44ADA) single instalment by 15 Mar per s.211(1)(b). Verified 2026-07-21 and adversarially re-checked. Note the s.211(1) proviso: anything paid on or before 31 March still counts as advance tax for that year.",
  },
  itr: {
    upto_fy: "2025-26",
    from_fy: "2025-26",
    note: "For the FY just ended: 30 Nov where s.92E (transfer pricing) applies; 31 Oct for companies and audit cases; 31 Aug for business or professional income not requiring audit — which includes a non-audited firm AND its partners; 31 Jul for any other assessee. The test is the INCOME, not the ITR form number.",
    verified: true,
    source:
      "Income-tax Act 1961 s.139(1) Explanation 2 as substituted by Finance Act 2026 s.5 (gazette CG-DL-E-31032026-271439), w.e.f. 1 March 2026 and therefore reaching AY 2026-27 = FY 2025-26. Verified 2026-07-21; adversarially re-checked on all four parts, including that Sl.3 says \"assessee\" and so covers a non-audited firm filing ITR-5. Extensions by notification are not tracked.",
  },
};

/**
 * The rule as it stood in a given FY. Falls back to the current authority when
 * the year has no separate entry (GST rules, which ITA 2025 did not touch).
 */
export function ruleForFy(code: string, fy: string): ComplianceRule {
  const current = complianceRule(code);
  if (!current) throw new Error(`Unknown compliance rule "${code}"`);
  const prior = PRIOR_AUTHORITIES[code];
  if (!prior || fy > prior.upto_fy) return current;
  // An entry with a lower bound does not describe years before it.
  if (prior.from_fy && fy < prior.from_fy) {
    return {
      ...current,
      verified: false,
      source:
        `No authority on file for ${code} in FY ${fy}. This app was built for ` +
        `FY 2025-26 onward; earlier years need their own statute checked.`,
    };
  }
  return { ...current, note: prior.note, verified: prior.verified, source: prior.source };
}

/** Return-form names for the FY — 26Q/24Q up to FY 2025-26, Form 140/138 after. */
export function tdsReturnForms(fy: string): string {
  const prior = PRIOR_AUTHORITIES["tds-return"];
  return prior && fy <= prior.upto_fy ? (prior.forms ?? "26Q/24Q") : "Form 140/138";
}

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
  // Resolve each rule AS IT STOOD IN THIS FY — same dates, different statute.
  const rule = (code: string): ComplianceRule => ruleForFy(code, fy);

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
          `${tdsReturnForms(fy)} statement for ${QUARTER_MONTHS[q - 1]}`,
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
 * ITR for the FY is due in the NEXT year.
 *
 * Tiers are the substituted Explanation 2 to s.139(1) of the **1961** Act
 * (Finance Act 2026 s.5, w.e.f. 1 March 2026, so it reaches AY 2026-27 =
 * FY 2025-26), and the mirrored provision under ITA 2025 for later years:
 *
 *   Sl.1  s.92E (transfer pricing) applies          30 Nov
 *   Sl.2  company / accounts requiring audit         31 Oct
 *   Sl.3  business or professional income, NOT
 *         required to be audited                     31 Aug
 *   Sl.4  any other assessee                         31 Jul
 *
 * THE DISCRIMINATOR IS INCOME-BASED, NOT FORM-BASED. The widely repeated
 * gloss that "31 Aug applies to ITR-3/ITR-4 filers" is wrong: Sl.3 says
 * "ASSESSEE having income from profits and gains of business or profession
 * whose accounts are not required to be audited", and Sl.3(ii) separately
 * covers that firm's partners. A non-audited partnership firm filing ITR-5 is
 * therefore inside Sl.3, and so are its partners — which is why entity_type
 * does not gate this.
 *
 * Every business whose books this app keeps has business income, so Sl.4
 * (31 Jul) does not arise here — it is the tier for salary/capital-gains-only
 * assessees, who have no books to keep.
 *
 * This REPLACED an earlier conservative default of 31 Jul. That default was
 * not the safe choice, it was simply wrong by a month: the tier is verbatim
 * in the signed Gazette, confirmed on all four parts (does FA 2026 s.5 amend
 * the 1961 Act; does 1 Mar 2026 reach AY 2026-27; is the tier real; does it
 * cover a firm) by an adversarial pass instructed to refute it.
 */
export function itrItem(
  fy: string,
  auditCase: boolean,
  entityType: EntityType = "proprietorship"
): Unmarked {
  const y = fyStartYear(fy);
  const r = ruleForFy("itr", fy);
  const audit = auditCase || entityType === "company";
  // The 31 Aug tier exists from AY 2026-27 (= FY 2025-26) onward. Earlier
  // years keep the pre-amendment 31 Jul.
  const businessNonAudit = fy >= "2025-26";
  const due = audit
    ? `${y + 1}-10-31`
    : businessNonAudit
      ? `${y + 1}-08-31`
      : `${y + 1}-07-31`;
  return bare(
    r,
    fy,
    fyLabel(fy),
    audit
      ? "Return for the FY (company / audit case)"
      : "Return for the FY (business income, no audit)",
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
  book: Book,
  fy: string,
  settings: SettingsRow,
  today: string
): ComplianceItem[] {
  if (!ISO_DATE.test(today)) throw new Error(`Bad today "${today}"`);
  const hasTds =
    (
      book.get(
        `SELECT COUNT(*) AS n FROM tds_entries
         WHERE company_id = @company_id AND entry_date BETWEEN @from AND @to`,
        { from: fyStart(fy), to: fyEnd(fy) }
      ) as { n: number }
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
  for (const m of book.all(
    "SELECT * FROM compliance_marks WHERE company_id = @company_id"
  ) as ComplianceMarkRow[]) {
    marks.set(`${m.rule_code} ${m.period}`, m);
  }

  const ruleOrder = new Map(RULES.map((r, i) => [r.code, i]));
  return unmarked
    .map((item): ComplianceItem => {
      const mark = marks.get(`${item.rule_code} ${item.period}`);
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
