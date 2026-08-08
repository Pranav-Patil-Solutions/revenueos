import { NextRequest, NextResponse } from "next/server";
import { getCompany } from "@/lib/companies";
import { paiseToRupeeString, thisMonth, toCsv, todayIso } from "@/lib/format";
import { fyEnd, fyStart } from "@/lib/fy";
import {
  balanceSheet,
  dayBook,
  gstr1B2B,
  gstr3b,
  partyStatement,
  profitAndLoss,
  trialBalance,
  type PnlPeriod,
} from "@/lib/reports";
import { buildComputation } from "@/lib/tax/computation";
import { q24Summary, q26Summary, TDS_SECTIONS } from "@/lib/tax/tds";
import {
  blockFor,
  depreciationSchedule,
  HALF_YEAR_DAYS,
} from "@/lib/tax/depreciation";
import { requireApiBook } from "@/lib/dal";

const rupees = paiseToRupeeString;

/** ?fy= value → FY key, or null when absent/invalid. */
function parseFy(sp: URLSearchParams): string | null {
  const fy = sp.get("fy");
  if (!fy) return null;
  try {
    fyStart(fy);
    return fy;
  } catch {
    return null;
  }
}

/** CSV/JSON exports for every report. Money is exported as decimal-rupee
 * strings (exact — derived from integer paise, never floats). */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ report: string }> }
) {
  const gate = await requireApiBook();
  if (gate instanceof Response) return gate;
  const { book } = gate;
  const { report } = await params;
  const sp = req.nextUrl.searchParams;
  const format = sp.get("format") ?? "json";
  const month = sp.get("month") ?? thisMonth();
  const partyId = Number(sp.get("party") ?? 0);

  if (format !== "csv" && format !== "json") {
    return NextResponse.json({ error: "format must be csv or json" }, { status: 400 });
  }
  if (!/^\d{4}-\d{2}$/.test(month)) {
    return NextResponse.json({ error: "month must be YYYY-MM" }, { status: 400 });
  }

  let filename: string;
  let headers: string[];
  let rows: (string | number | null)[][];
  let json: unknown;

  switch (report) {
    case "trial-balance": {
      const tb = trialBalance(book);
      filename = "trial-balance";
      headers = ["Code", "Account", "Type", "Debit", "Credit"];
      rows = tb.lines.map((l) => [
        l.code, l.name, l.type, rupees(l.debit_paise), rupees(l.credit_paise),
      ]);
      rows.push(["", "TOTAL", "", rupees(tb.total_debit_paise), rupees(tb.total_credit_paise)]);
      json = {
        lines: tb.lines.map((l) => ({
          code: l.code, account: l.name, type: l.type,
          debit: rupees(l.debit_paise), credit: rupees(l.credit_paise),
        })),
        total_debit: rupees(tb.total_debit_paise),
        total_credit: rupees(tb.total_credit_paise),
        balanced: tb.balanced,
      };
      break;
    }
    case "day-book": {
      const entries = dayBook(book, sp.has("month") ? month : undefined);
      filename = "day-book";
      headers = ["Date", "Journal", "Type", "Memo", "Ref", "Account", "Party", "Debit", "Credit"];
      rows = entries.flatMap((e) =>
        e.legs.map((l) => [
          e.entry_date, e.id, e.entry_type, e.memo, e.ref_no,
          `${l.account_code} ${l.account_name}`, l.party_name ?? "",
          rupees(l.debit_paise), rupees(l.credit_paise),
        ])
      );
      json = entries.map((e) => ({
        journal: e.id, date: e.entry_date, type: e.entry_type, memo: e.memo, ref: e.ref_no,
        legs: e.legs.map((l) => ({
          account: `${l.account_code} ${l.account_name}`, party: l.party_name,
          debit: rupees(l.debit_paise), credit: rupees(l.credit_paise),
        })),
      }));
      break;
    }
    case "pnl": {
      const fy = parseFy(sp);
      if (sp.has("fy") && !fy) {
        return NextResponse.json({ error: "fy must look like 2026-27" }, { status: 400 });
      }
      const period: PnlPeriod | undefined = fy
        ? { from: fyStart(fy), to: fyEnd(fy) }
        : sp.has("month")
          ? month
          : undefined;
      const pnl = profitAndLoss(book, period);
      filename = fy ? `profit-and-loss-fy-${fy}` : "profit-and-loss";
      headers = ["Section", "Code", "Account", "Amount"];
      rows = [
        ...pnl.income_lines.map((l) => ["Income", l.code, l.name, rupees(l.amount_paise)]),
        ...pnl.expense_lines.map((l) => ["Expenses", l.code, l.name, rupees(l.amount_paise)]),
        ["", "", "Total income", rupees(pnl.total_income_paise)],
        ["", "", "Total expenses", rupees(pnl.total_expense_paise)],
        ["", "", "Net profit", rupees(pnl.net_profit_paise)],
      ];
      json = {
        income: pnl.income_lines.map((l) => ({ code: l.code, account: l.name, amount: rupees(l.amount_paise) })),
        expenses: pnl.expense_lines.map((l) => ({ code: l.code, account: l.name, amount: rupees(l.amount_paise) })),
        total_income: rupees(pnl.total_income_paise),
        total_expenses: rupees(pnl.total_expense_paise),
        net_profit: rupees(pnl.net_profit_paise),
      };
      break;
    }
    case "gstr-3b": {
      const g = gstr3b(book, month);
      filename = `gstr-3b-${month}`;
      headers = ["Field", "Value"];
      rows = [
        ["Month", month],
        ["Outward taxable supplies (3.1a taxable value)", rupees(g.outward_taxable_paise)],
        ["CGST", rupees(g.cgst_paise)],
        ["SGST", rupees(g.sgst_paise)],
        ["IGST", rupees(g.igst_paise)],
        ["Eligible ITC", rupees(g.itc_paise)],
        ["Net payable", rupees(g.net_payable_paise)],
      ];
      json = {
        month,
        outward_taxable: rupees(g.outward_taxable_paise),
        cgst: rupees(g.cgst_paise),
        sgst: rupees(g.sgst_paise),
        igst: rupees(g.igst_paise),
        itc: rupees(g.itc_paise),
        net_payable: rupees(g.net_payable_paise),
      };
      break;
    }
    case "gstr-1": {
      const list = gstr1B2B(book, month);
      filename = `gstr-1-b2b-${month}`;
      headers = ["Party", "GSTIN", "State", "Date", "Doc type", "Ref", "Taxable", "CGST", "SGST", "IGST", "Gross"];
      rows = list.map((r) => [
        r.party_name, r.party_gstin, r.party_state_code, r.entry_date, r.doc_type, r.ref_no,
        rupees(r.taxable_paise), rupees(r.cgst_paise), rupees(r.sgst_paise),
        rupees(r.igst_paise), rupees(r.gross_paise),
      ]);
      json = list.map((r) => ({
        party: r.party_name, gstin: r.party_gstin, state: r.party_state_code,
        date: r.entry_date, doc_type: r.doc_type, ref: r.ref_no,
        taxable: rupees(r.taxable_paise), cgst: rupees(r.cgst_paise),
        sgst: rupees(r.sgst_paise), igst: rupees(r.igst_paise), gross: rupees(r.gross_paise),
      }));
      break;
    }
    case "statement": {
      const s = partyId > 0 ? partyStatement(book, partyId) : null;
      if (!s) {
        return NextResponse.json({ error: "statement needs a valid ?party=<id>" }, { status: 400 });
      }
      filename = `statement-${s.party.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
      headers = ["Date", "Type", "Memo", "Ref", "Debit", "Credit", "Balance"];
      rows = s.lines.map((l) => [
        l.entry_date, l.entry_type, l.memo, l.ref_no,
        rupees(l.debit_paise), rupees(l.credit_paise), rupees(l.balance_paise),
      ]);
      json = {
        party: { name: s.party.name, kind: s.party.kind, gstin: s.party.gstin },
        closing_balance: rupees(s.closing_paise),
        cross_ledger_balance: rupees(s.cross_ledger_paise),
        net_position: rupees(s.net_position_paise),
        lines: s.lines.map((l) => ({
          date: l.entry_date, type: l.entry_type, memo: l.memo, ref: l.ref_no,
          debit: rupees(l.debit_paise), credit: rupees(l.credit_paise),
          balance: rupees(l.balance_paise),
        })),
      };
      break;
    }
    case "balance-sheet": {
      const asOfParam = sp.get("as_of");
      if (asOfParam && !/^\d{4}-\d{2}-\d{2}$/.test(asOfParam)) {
        return NextResponse.json({ error: "as_of must be YYYY-MM-DD" }, { status: 400 });
      }
      const fy = parseFy(sp);
      if (sp.has("fy") && !fy) {
        return NextResponse.json({ error: "fy must look like 2026-27" }, { status: 400 });
      }
      const asOf = asOfParam ?? (fy ? fyEnd(fy) : todayIso());
      const settings = getCompany(book.db, book.companyId)!;
      const bs = balanceSheet(book, asOf, settings);
      filename = `balance-sheet-${asOf}`;
      headers = ["Section", "Group", "Code", "Account", "Amount"];
      const sectionLabel = (s: string): string =>
        s === "assets" ? "Assets" : "Capital & liabilities";
      rows = bs.groups.flatMap((g) => [
        ...g.lines.map((l) => [
          sectionLabel(g.section), g.label, l.code, l.name, rupees(l.amount_paise),
        ]),
        [sectionLabel(g.section), g.label, "", `Total ${g.label.toLowerCase()}`, rupees(g.total_paise)],
      ]);
      rows.push(
        ["Assets", "", "", "TOTAL ASSETS", rupees(bs.total_assets_paise)],
        ["Capital & liabilities", "", "", "TOTAL CAPITAL & LIABILITIES",
          rupees(bs.total_liabilities_paise + bs.total_equity_paise)],
      );
      json = {
        as_of: bs.as_of,
        fy: bs.fy,
        groups: bs.groups.map((g) => ({
          section: g.section,
          group: g.label,
          lines: g.lines.map((l) => ({
            code: l.code, account: l.name, amount: rupees(l.amount_paise),
          })),
          total: rupees(g.total_paise),
        })),
        retained_earnings_prior: rupees(bs.retained_prior_paise),
        current_year_profit: rupees(bs.current_year_profit_paise),
        total_assets: rupees(bs.total_assets_paise),
        total_liabilities: rupees(bs.total_liabilities_paise),
        total_equity: rupees(bs.total_equity_paise),
        balanced: bs.balanced,
      };
      break;
    }
    case "depreciation": {
      const fy = parseFy(sp);
      if (!fy) {
        return NextResponse.json(
          { error: "depreciation needs fy, e.g. ?fy=2026-27" },
          { status: 400 }
        );
      }
      const schedule = depreciationSchedule(book, fy);
      filename = `depreciation-${fy}`;
      headers = [
        "Block", "Rate %", "Opening", "Additions (full rate)",
        "Additions (half rate)", "Disposals", "Depreciation", "Closing",
      ];
      rows = schedule.blocks.map((b) => [
        blockFor(b.block)?.label ?? b.block,
        b.rate,
        rupees(b.opening_paise),
        rupees(b.additions_full_paise),
        rupees(b.additions_half_paise),
        rupees(b.disposals_paise),
        rupees(b.depreciation_paise),
        rupees(b.closing_paise),
      ]);
      rows.push([
        "TOTAL", "", "", "", "", "",
        rupees(schedule.total_depreciation_paise),
        rupees(schedule.total_closing_paise),
      ]);
      json = {
        fy: schedule.fy,
        // No section number: the Income-tax Act, 2025 (in force 1 Apr 2026)
        // renumbered the 1961 Act's, and an unverified citation must not ride
        // out on an export a CA signs.
        basis: "Written-down value, block method — Income-tax Act, India",
        half_year_rule_days: HALF_YEAR_DAYS,
        blocks: schedule.blocks.map((b) => ({
          block: b.block,
          label: blockFor(b.block)?.label ?? b.block,
          rate: b.rate,
          opening: rupees(b.opening_paise),
          opening_overridden: b.opening_overridden,
          additions_full_rate: rupees(b.additions_full_paise),
          additions_half_rate: rupees(b.additions_half_paise),
          disposals: rupees(b.disposals_paise),
          depreciation: rupees(b.depreciation_paise),
          closing: rupees(b.closing_paise),
        })),
        total_depreciation: rupees(schedule.total_depreciation_paise),
        total_closing: rupees(schedule.total_closing_paise),
        note: "CA to verify.",
      };
      break;
    }
    case "computation": {
      const fy = parseFy(sp);
      if (!fy) {
        return NextResponse.json(
          { error: "computation needs fy, e.g. ?fy=2026-27" },
          { status: 400 }
        );
      }
      const c = buildComputation(book, fy);
      filename = `computation-${fy}`;
      headers = ["Line", "Note", "Amount"];
      rows = [
        // The CSV is what gets pasted into a filing workpaper, so the caveat
        // has to lead — a spreadsheet of confident numbers with the warning
        // only in the JSON would defeat the point of tracking it at all.
        ...(c.caveat ? [["NOTE — rates not confirmed", c.caveat, ""]] : []),
        ["Rates applied", `tax year ${c.rates_tax_year}`, ""],
        ...c.lines.map((l) => [
          l.subtract ? `Less: ${l.label.replace(/^Less: /, "")}` : l.label,
          l.note ?? "",
          rupees(l.subtract ? -l.amount_paise : l.amount_paise),
        ]),
        ["Gross total income", "", rupees(c.gross_total_income_paise)],
        ["Total income (rounded)", "", rupees(c.taxable_income_paise)],
        [`Tax — ${c.tax.basis}`, "", rupees(c.tax.tax_before_rebate_paise)],
        ["Less: rebate", "", rupees(-c.tax.rebate_paise)],
        ["Add: surcharge", "", rupees(c.tax.surcharge_paise)],
        ["Less: marginal relief on surcharge", "", rupees(-c.tax.surcharge_marginal_relief_paise)],
        ["Add: cess", "", rupees(c.tax.cess_paise)],
        ["Total tax", "", rupees(c.tax.total_tax_paise)],
        ["Less: taxes paid", "", rupees(-c.payments_paise)],
        [
          c.net_payable_paise < 0 ? "Refund due" : "Balance payable",
          "",
          rupees(Math.abs(c.net_payable_paise)),
        ],
        ["Filing preparation only. CA to verify.", "", ""],
      ];
      // Stable shape — this is the seam a return-filing export would read.
      json = {
        fy: c.fy,
        entity_type: c.entity_type,
        regime: c.regime,
        presumptive: c.presumptive || null,
        rates_tax_year: c.rates_tax_year,
        provisional: c.provisional,
        caveat: c.caveat || null,
        book_profit: rupees(c.book_profit_paise),
        book_depreciation: rupees(c.book_depreciation_paise),
        it_depreciation: rupees(c.it_depreciation_paise),
        addbacks: rupees(c.addbacks_paise),
        deductions: rupees(c.deductions_paise),
        turnover: rupees(c.turnover_paise),
        lines: c.lines.map((l) => ({
          label: l.label,
          note: l.note ?? null,
          amount: rupees(l.subtract ? -l.amount_paise : l.amount_paise),
        })),
        gross_total_income: rupees(c.gross_total_income_paise),
        total_income: rupees(c.taxable_income_paise),
        tax: {
          basis: c.tax.basis,
          before_rebate: rupees(c.tax.tax_before_rebate_paise),
          rebate: rupees(c.tax.rebate_paise),
          surcharge: rupees(c.tax.surcharge_paise),
          surcharge_marginal_relief: rupees(c.tax.surcharge_marginal_relief_paise),
          cess: rupees(c.tax.cess_paise),
          total: rupees(c.tax.total_tax_paise),
        },
        payments: c.payments.map((p) => ({
          kind: p.kind,
          paid_on: p.paid_on,
          amount: rupees(p.amount_paise),
          note: p.note || null,
        })),
        payments_total: rupees(c.payments_paise),
        net_payable: rupees(c.net_payable_paise),
        advance_tax: c.advance_tax.map((a) => ({
          due: a.due,
          cumulative_percent: a.cumulative_percent,
          cumulative: rupees(a.cumulative_paise),
          instalment: rupees(a.instalment_paise),
        })),
        note: "Filing preparation only. CA to verify.",
      };
      break;
    }
    case "tds-26q":
    case "tds-24q": {
      const fy = parseFy(sp);
      const quarter = Number(sp.get("quarter"));
      if (!fy || ![1, 2, 3, 4].includes(quarter)) {
        return NextResponse.json(
          { error: "needs fy and quarter, e.g. ?fy=2026-27&quarter=1" },
          { status: 400 }
        );
      }
      const s =
        report === "tds-26q"
          ? q26Summary(book, fy, quarter as 1 | 2 | 3 | 4)
          : q24Summary(book, fy, quarter as 1 | 2 | 3 | 4);
      filename = `${report}-${fy}-q${quarter}`;
      headers = ["Payee", "PAN", "Section", "Deductions", "Base", "TDS"];
      rows = [
        // CSV-shaped return PREP, not the filing format itself — and every
        // rendering carries the qualifying notes (EVOLUTION #15): the
        // unverified-rates caveat only while a section is actually
        // unverified, the filing-identity note always.
        ...(TDS_SECTIONS.some((sec) => !sec.verified)
          ? [["NOTE — some section rates unconfirmed against the renumbered Act; verify before filing. CA to verify.", "", "", "", "", ""]]
          : []),
        [`NOTE — files on Form ${report === "tds-26q" ? "140 (old 26Q)" : "138 (old 24Q)"} from FY 2026-27 (Income-tax Rules 2026).`, "", "", "", "", ""],
        ...s.lines.map((l) => [
          l.party_name,
          l.party_pan || "MISSING",
          l.section,
          l.deductions,
          rupees(l.base_paise),
          rupees(l.tds_paise),
        ]),
        ["TOTAL", "", "", "", rupees(s.total_base_paise), rupees(s.total_tds_paise)],
      ];
      json = {
        form: s.form,
        fy: s.fy,
        quarter: s.quarter,
        lines: s.lines.map((l) => ({
          payee: l.party_name,
          pan: l.party_pan || null,
          section: l.section,
          deductions: l.deductions,
          base: rupees(l.base_paise),
          tds: rupees(l.tds_paise),
          missing_pan: l.missing_pan,
        })),
        total_base: rupees(s.total_base_paise),
        total_tds: rupees(s.total_tds_paise),
        missing_pan_count: s.missing_pan_count,
        undeposited: rupees(s.undeposited_paise),
        note: "Return prep only — section rates unconfirmed against the renumbered Act. CA to verify.",
      };
      break;
    }
    default:
      return NextResponse.json(
        { error: `unknown report '${report}' — use trial-balance, balance-sheet, day-book, pnl, gstr-3b, gstr-1, or statement` },
        { status: 404 }
      );
  }

  if (format === "json") return NextResponse.json(json);
  return new Response(toCsv(headers, rows), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}.csv"`,
    },
  });
}
