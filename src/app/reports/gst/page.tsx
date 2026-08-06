import { getCompany } from "@/lib/companies";
import { ExportLinks, ReportTabs } from "@/components/report-tabs";
import { inr, monthLabel, thisMonth } from "@/lib/format";
import { gstr1B2B, gstr3b } from "@/lib/reports";
import { requireBook } from "@/lib/dal";

export const dynamic = "force-dynamic";

export default async function GstReportPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string }>;
}) {
  const { book } = await requireBook();

  const sp = await searchParams;
  const month = /^\d{4}-\d{2}$/.test(sp.month ?? "") ? sp.month! : thisMonth();
  const settings = getCompany(book.db, book.companyId)!;
  const g = gstr3b(book, month);
  const b2b = gstr1B2B(book, month);

  const row = "flex items-center justify-between border-b border-hairline/60 px-5 py-3 last:border-0";

  return (
    <div>
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight">GST filing prep</h1>
          <p className="mt-1 text-[13.5px] text-ink-3">
            {settings.company_name}
            {settings.gstin ? ` · GSTIN ${settings.gstin}` : " · set your GSTIN in Settings"}
          </p>
        </div>
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
      </div>

      <ReportTabs />

      <div className="mt-6 grid gap-6 lg:grid-cols-[360px_1fr]">
        <div className="h-fit rounded-xl border border-hairline bg-surface">
          <div className="flex items-center justify-between border-b border-hairline px-5 py-3.5">
            <p className="text-[13.5px] font-semibold">
              GSTR-3B · {monthLabel(month)}
            </p>
            <ExportLinks base={`/api/export/gstr-3b?month=${month}`} />
          </div>
          <div style={{ fontVariantNumeric: "tabular-nums" }}>
            <div className={row}>
              <span className="text-[13px] text-ink-2">Outward taxable supplies (3.1a)</span>
              <span className="text-[13px] font-medium">{inr(g.outward_taxable_paise)}</span>
            </div>
            <div className={row}>
              <span className="text-[13px] text-ink-2">CGST</span>
              <span className="text-[13px] font-medium">{inr(g.cgst_paise)}</span>
            </div>
            <div className={row}>
              <span className="text-[13px] text-ink-2">SGST</span>
              <span className="text-[13px] font-medium">{inr(g.sgst_paise)}</span>
            </div>
            <div className={row}>
              <span className="text-[13px] text-ink-2">IGST</span>
              <span className="text-[13px] font-medium">{inr(g.igst_paise)}</span>
            </div>
            <div className={row}>
              <span className="text-[13px] text-ink-2">Eligible ITC</span>
              <span className="text-[13px] font-medium text-good">− {inr(g.itc_paise)}</span>
            </div>
            <div className="flex items-center justify-between bg-surface-2/50 px-5 py-3.5">
              <span className="text-[13px] font-semibold">Net payable</span>
              <span className="text-[15px] font-semibold text-accent">
                {inr(g.net_payable_paise)}
              </span>
            </div>
          </div>
        </div>

        <div className="rounded-xl border border-hairline bg-surface">
          <div className="flex items-center justify-between border-b border-hairline px-5 py-3.5">
            <p className="text-[13.5px] font-semibold">GSTR-1 · B2B documents</p>
            <ExportLinks base={`/api/export/gstr-1?month=${month}`} />
          </div>
          {b2b.length === 0 ? (
            <div className="px-6 py-12 text-center">
              <p className="text-[13.5px] font-medium text-ink-2">
                No outward documents in {monthLabel(month)}
              </p>
              <p className="mt-1 text-[12.5px] text-ink-3">
                Post sales or credit notes and they appear here.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-[12.5px]">
                <thead>
                  <tr className="border-b border-hairline text-[11.5px] uppercase tracking-wide text-ink-3">
                    <th className="px-5 py-3 font-medium">Party</th>
                    <th className="px-4 py-3 font-medium">Date</th>
                    <th className="px-4 py-3 font-medium">Type</th>
                    <th className="px-4 py-3 font-medium">Ref</th>
                    <th className="px-4 py-3 text-right font-medium">Taxable</th>
                    <th className="px-4 py-3 text-right font-medium">CGST</th>
                    <th className="px-4 py-3 text-right font-medium">SGST</th>
                    <th className="px-4 py-3 text-right font-medium">IGST</th>
                    <th className="px-5 py-3 text-right font-medium">Gross</th>
                  </tr>
                </thead>
                <tbody style={{ fontVariantNumeric: "tabular-nums" }}>
                  {b2b.map((r) => (
                    <tr key={r.journal_id} className="border-b border-hairline/60 last:border-0">
                      <td className="px-5 py-3">
                        <span className="font-medium">{r.party_name}</span>
                        {r.party_gstin && (
                          <span className="ml-2 text-[11px] text-ink-3">{r.party_gstin}</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-ink-2">{r.entry_date}</td>
                      <td className="px-4 py-3">
                        <span
                          className={`rounded-full border border-hairline bg-surface-2 px-2 py-0.5 text-[11px] font-medium ${
                            r.doc_type === "Credit note" ? "text-warning" : "text-ink-2"
                          }`}
                        >
                          {r.doc_type}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-ink-2">{r.ref_no || "—"}</td>
                      <td className="px-4 py-3 text-right">{inr(r.taxable_paise)}</td>
                      <td className="px-4 py-3 text-right text-ink-2">{inr(r.cgst_paise)}</td>
                      <td className="px-4 py-3 text-right text-ink-2">{inr(r.sgst_paise)}</td>
                      <td className="px-4 py-3 text-right text-ink-2">{inr(r.igst_paise)}</td>
                      <td className="px-5 py-3 text-right font-medium">{inr(r.gross_paise)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      <p className="mt-4 text-[12px] leading-relaxed text-ink-3">
        Filing-prep figures for your CA or GST portal entry — not the official
        GSTN JSON schema, and net of credit notes. Real e-filing is out of scope for v1.
      </p>
    </div>
  );
}
