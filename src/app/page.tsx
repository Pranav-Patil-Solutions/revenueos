import Link from "next/link";
import { StatTile } from "@/components/stat-tile";
import { StatusBadge } from "@/components/status-badge";
import { formatTimestamp, inr, monthLabel, thisMonth } from "@/lib/format";
import { dashboardStats } from "@/lib/reports";
import type { DocumentWithParty } from "@/lib/types";
import { requireBook } from "@/lib/dal";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const { book } = await requireBook();

  const month = thisMonth();
  const stats = dashboardStats(book, month);
  const recent = book.all<DocumentWithParty>(
    `SELECT d.*, p.name AS party_name, p.kind AS party_kind, p.state_code AS party_state_code
     FROM documents d
     JOIN parties p ON p.id = d.party_id AND p.company_id = @company_id
     WHERE d.company_id = @company_id
     ORDER BY d.id DESC LIMIT 8`
  );

  return (
    <div>
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight">Overview</h1>
          <p className="mt-1 text-[13.5px] text-ink-3">
            Receivables, GST position, and what needs your review.
          </p>
        </div>
        <Link
          href="/capture"
          className="rounded-lg bg-accent px-4 py-2 text-[13px] font-medium text-white transition-opacity hover:opacity-90"
        >
          Capture a page
        </Link>
      </div>

      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Receivables" value={inr(stats.receivables_paise)} />
        <StatTile
          label={`GST payable · ${monthLabel(month)}`}
          value={inr(stats.gst_payable_paise)}
        />
        <StatTile label="Pages pending review" value={String(stats.pending_review)} />
        <StatTile label="Journals this month" value={String(stats.journals_this_month)} />
      </div>

      <div className="mt-6">
        <div className="mb-3 flex items-center justify-between">
          <p className="text-[13.5px] font-semibold">Recent activity</p>
          <Link href="/documents" className="text-[12.5px] font-medium text-accent hover:opacity-80">
            All documents
          </Link>
        </div>
        {recent.length === 0 ? (
          <div className="rounded-xl border border-hairline bg-surface px-6 py-14 text-center">
            <p className="text-[13.5px] font-medium text-ink-2">Nothing here yet</p>
            <p className="mt-1 text-[12.5px] text-ink-3">
              Photograph a ledger page and the pipeline starts: extract → review → post → reports.
            </p>
            <Link
              href="/capture"
              className="mt-4 inline-block rounded-lg bg-accent px-4 py-2 text-[13px] font-medium text-white transition-opacity hover:opacity-90"
            >
              Capture your first page
            </Link>
          </div>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-hairline bg-surface">
            <table className="w-full text-left text-[13px]">
              <thead>
                <tr className="border-b border-hairline text-[11.5px] uppercase tracking-wide text-ink-3">
                  <th className="px-5 py-3 font-medium">Page</th>
                  <th className="px-5 py-3 font-medium">Party</th>
                  <th className="px-5 py-3 font-medium">Status</th>
                  <th className="px-5 py-3 text-right font-medium">Captured</th>
                  <th className="px-5 py-3" />
                </tr>
              </thead>
              <tbody style={{ fontVariantNumeric: "tabular-nums" }}>
                {recent.map((d) => (
                  <tr key={d.id} className="border-b border-hairline/60 last:border-0 hover:bg-surface-2/50">
                    <td className="px-5 py-3.5">
                      <Link href={`/documents/${d.id}`} className="font-medium text-ink hover:text-accent">
                        #{d.id}
                      </Link>
                    </td>
                    <td className="px-5 py-3.5 text-ink-2">{d.party_name}</td>
                    <td className="px-5 py-3.5">
                      <StatusBadge status={d.status} />
                    </td>
                    <td className="px-5 py-3.5 text-right text-ink-3">{formatTimestamp(d.created_at)}</td>
                    <td className="px-5 py-3.5 text-right">
                      <Link
                        href={`/documents/${d.id}`}
                        className="text-[12.5px] font-medium text-accent hover:opacity-80"
                      >
                        {d.status === "extracted" ? "Review" : "View"}
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
