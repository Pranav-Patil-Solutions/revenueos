import { getDb } from "@/lib/db";
import { ExportLinks, ReportTabs } from "@/components/report-tabs";
import { inr, monthLabel } from "@/lib/format";
import { profitAndLoss } from "@/lib/reports";

export const dynamic = "force-dynamic";

export default async function PnlPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string }>;
}) {
  const sp = await searchParams;
  const month = /^\d{4}-\d{2}$/.test(sp.month ?? "") ? sp.month : undefined;
  const pnl = profitAndLoss(getDb(), month);
  const hasData = pnl.income_lines.length > 0 || pnl.expense_lines.length > 0;

  const line = "flex items-center justify-between px-5 py-2.5 text-[13px]";

  return (
    <div>
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight">Profit &amp; loss</h1>
          <p className="mt-1 text-[13.5px] text-ink-3">
            {month ? monthLabel(month) : "All time"} — income against purchases and expenses.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <form className="flex items-center gap-2" method="GET">
            <input
              type="month"
              name="month"
              defaultValue={month}
              className="rounded-lg border border-hairline bg-surface-2 px-3 py-1.5 text-[13px] text-ink outline-none focus:border-accent"
            />
            <button
              type="submit"
              className="rounded-lg border border-hairline bg-surface-2 px-3 py-1.5 text-[13px] font-medium text-ink-2 hover:text-ink"
            >
              Apply
            </button>
          </form>
          <ExportLinks base={`/api/export/pnl${month ? `?month=${month}` : ""}`} />
        </div>
      </div>

      <ReportTabs />

      {!hasData ? (
        <div className="mt-6 rounded-xl border border-hairline bg-surface px-6 py-14 text-center">
          <p className="text-[13.5px] font-medium text-ink-2">Nothing to report yet</p>
          <p className="mt-1 text-[12.5px] text-ink-3">
            Post sales and purchases and the P&amp;L builds itself.
          </p>
        </div>
      ) : (
        <div className="mt-6 max-w-xl rounded-xl border border-hairline bg-surface" style={{ fontVariantNumeric: "tabular-nums" }}>
          <p className="border-b border-hairline px-5 py-3 text-[11.5px] font-medium uppercase tracking-wide text-ink-3">
            Income
          </p>
          {pnl.income_lines.map((l) => (
            <div key={l.code} className={line}>
              <span className="text-ink-2">{l.code} {l.name}</span>
              <span className="font-medium">{inr(l.amount_paise)}</span>
            </div>
          ))}
          <div className={`${line} border-t border-hairline/60 font-semibold`}>
            <span>Total income</span>
            <span>{inr(pnl.total_income_paise)}</span>
          </div>

          <p className="border-y border-hairline px-5 py-3 text-[11.5px] font-medium uppercase tracking-wide text-ink-3">
            Expenses
          </p>
          {pnl.expense_lines.map((l) => (
            <div key={l.code} className={line}>
              <span className="text-ink-2">{l.code} {l.name}</span>
              <span className="font-medium">{inr(l.amount_paise)}</span>
            </div>
          ))}
          <div className={`${line} border-t border-hairline/60 font-semibold`}>
            <span>Total expenses</span>
            <span>{inr(pnl.total_expense_paise)}</span>
          </div>

          <div className="flex items-center justify-between border-t border-hairline bg-surface-2/50 px-5 py-3.5">
            <span className="text-[13.5px] font-semibold">Net profit</span>
            <span className={`text-[15px] font-semibold ${pnl.net_profit_paise >= 0 ? "text-good" : "text-critical"}`}>
              {inr(pnl.net_profit_paise)}
            </span>
          </div>
        </div>
      )}

      <p className="mt-4 max-w-xl text-[12px] leading-relaxed text-ink-3">
        GST collected and input credit ride the balance sheet, not the P&amp;L —
        income and purchases here are taxable values.
      </p>
    </div>
  );
}
