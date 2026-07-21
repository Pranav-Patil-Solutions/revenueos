import { getDb } from "@/lib/db";
import { ExportLinks, ReportTabs } from "@/components/report-tabs";
import { formatDate, inr, monthLabel } from "@/lib/format";
import { dayBook } from "@/lib/reports";
import { requireSession } from "@/lib/dal";

export const dynamic = "force-dynamic";

export default async function DayBookPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string }>;
}) {
  await requireSession();

  const sp = await searchParams;
  const month = /^\d{4}-\d{2}$/.test(sp.month ?? "") ? sp.month : undefined;
  const entries = dayBook(getDb(), month);

  return (
    <div>
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight">Day book</h1>
          <p className="mt-1 text-[13.5px] text-ink-3">
            Every journal in date order, with its legs.
            {month ? ` Showing ${monthLabel(month)}.` : ""}
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
          <ExportLinks base={`/api/export/day-book${month ? `?month=${month}` : ""}`} />
        </div>
      </div>

      <ReportTabs />

      {entries.length === 0 ? (
        <div className="mt-6 rounded-xl border border-hairline bg-surface px-6 py-14 text-center">
          <p className="text-[13.5px] font-medium text-ink-2">No journals yet</p>
          <p className="mt-1 text-[12.5px] text-ink-3">
            Post a reviewed document and its journals land here.
          </p>
        </div>
      ) : (
        <div className="mt-6 flex flex-col gap-3">
          {entries.map((e) => (
            <div key={e.id} className="rounded-xl border border-hairline bg-surface">
              <div className="flex items-center justify-between border-b border-hairline px-5 py-2.5">
                <p className="text-[13px]">
                  <span className="font-medium">{formatDate(e.entry_date)}</span>
                  <span className="ml-2 rounded-full border border-hairline bg-surface-2 px-2 py-0.5 text-[11px] font-medium capitalize text-ink-2">
                    {e.entry_type.replace("_", " ")}
                  </span>
                  <span className="ml-2 text-ink-3">{e.memo}</span>
                  {e.ref_no && <span className="ml-2 text-[11.5px] text-ink-3">#{e.ref_no}</span>}
                </p>
                <p className="text-[11.5px] text-ink-3">
                  J-{e.id}
                  {e.source_document_id ? ` · page #${e.source_document_id}` : ""}
                </p>
              </div>
              <table className="w-full text-left text-[12.5px]">
                <tbody style={{ fontVariantNumeric: "tabular-nums" }}>
                  {e.legs.map((l, i) => (
                    <tr key={i} className="border-b border-hairline/40 last:border-0">
                      <td className="px-5 py-2 text-ink-2">
                        {l.debit_paise > 0 ? "" : " To "}
                        {l.account_name}
                        {l.party_name && (
                          <span className="ml-1.5 text-[11px] text-ink-3">({l.party_name})</span>
                        )}
                      </td>
                      <td className="w-32 px-4 py-2 text-right">
                        {l.debit_paise > 0 ? inr(l.debit_paise) : ""}
                      </td>
                      <td className="w-32 px-5 py-2 text-right text-ink-2">
                        {l.credit_paise > 0 ? inr(l.credit_paise) : ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
