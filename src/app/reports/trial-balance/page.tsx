import { getDb } from "@/lib/db";
import { ExportLinks, ReportTabs } from "@/components/report-tabs";
import { inr } from "@/lib/format";
import { trialBalance } from "@/lib/reports";
import { requireSession } from "@/lib/dal";

export const dynamic = "force-dynamic";

export default async function TrialBalancePage() {
  await requireSession();

  const tb = trialBalance(getDb());

  return (
    <div>
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight">Trial balance</h1>
          <p className="mt-1 text-[13.5px] text-ink-3">
            Every account&apos;s net position — debits must equal credits.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {/* The zero-check badge: trialBalance() throws if the books ever
              drift, so rendering this page IS the proof. */}
          <span className="inline-flex items-center gap-1.5 rounded-full border border-good/40 bg-good/10 px-3 py-1 text-[12px] font-medium text-good">
            <span className="size-1.5 rounded-full bg-good" />
            Balanced — Dr − Cr = {inr(tb.total_debit_paise - tb.total_credit_paise)}
          </span>
          <ExportLinks base="/api/export/trial-balance" />
        </div>
      </div>

      <ReportTabs />

      {tb.lines.length === 0 ? (
        <div className="mt-6 rounded-xl border border-hairline bg-surface px-6 py-14 text-center">
          <p className="text-[13.5px] font-medium text-ink-2">Nothing posted yet</p>
          <p className="mt-1 text-[12.5px] text-ink-3">
            Post a reviewed document and the balances land here.
          </p>
        </div>
      ) : (
        <div className="mt-6 overflow-x-auto rounded-xl border border-hairline bg-surface">
          <table className="w-full text-left text-[13px]">
            <thead>
              <tr className="border-b border-hairline text-[11.5px] uppercase tracking-wide text-ink-3">
                <th className="px-5 py-3 font-medium">Code</th>
                <th className="px-5 py-3 font-medium">Account</th>
                <th className="px-5 py-3 font-medium">Type</th>
                <th className="px-5 py-3 text-right font-medium">Debit</th>
                <th className="px-5 py-3 text-right font-medium">Credit</th>
              </tr>
            </thead>
            <tbody style={{ fontVariantNumeric: "tabular-nums" }}>
              {tb.lines.map((l) => (
                <tr key={l.code} className="border-b border-hairline/60 last:border-0">
                  <td className="px-5 py-3 text-ink-3">{l.code}</td>
                  <td className="px-5 py-3 font-medium">{l.name}</td>
                  <td className="px-5 py-3 capitalize text-ink-3">{l.type}</td>
                  <td className="px-5 py-3 text-right">
                    {l.debit_paise > 0 ? inr(l.debit_paise) : ""}
                  </td>
                  <td className="px-5 py-3 text-right">
                    {l.credit_paise > 0 ? inr(l.credit_paise) : ""}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-hairline bg-surface-2/50 font-semibold">
                <td className="px-5 py-3.5" colSpan={3}>
                  Total
                </td>
                <td className="px-5 py-3.5 text-right" style={{ fontVariantNumeric: "tabular-nums" }}>
                  {inr(tb.total_debit_paise)}
                </td>
                <td className="px-5 py-3.5 text-right" style={{ fontVariantNumeric: "tabular-nums" }}>
                  {inr(tb.total_credit_paise)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}
