import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { paiseToRupeeString, thisMonth, toCsv } from "@/lib/format";
import {
  dayBook,
  gstr1B2B,
  gstr3b,
  partyStatement,
  profitAndLoss,
  trialBalance,
} from "@/lib/reports";

const rupees = paiseToRupeeString;

/** CSV/JSON exports for every report. Money is exported as decimal-rupee
 * strings (exact — derived from integer paise, never floats). */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ report: string }> }
) {
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

  const db = getDb();
  let filename: string;
  let headers: string[];
  let rows: (string | number | null)[][];
  let json: unknown;

  switch (report) {
    case "trial-balance": {
      const tb = trialBalance(db);
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
      const entries = dayBook(db, sp.has("month") ? month : undefined);
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
      const pnl = profitAndLoss(db, sp.has("month") ? month : undefined);
      filename = "profit-and-loss";
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
      const g = gstr3b(db, month);
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
      const list = gstr1B2B(db, month);
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
      const s = partyId > 0 ? partyStatement(db, partyId) : null;
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
    default:
      return NextResponse.json(
        { error: `unknown report '${report}' — use trial-balance, day-book, pnl, gstr-3b, gstr-1, or statement` },
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
