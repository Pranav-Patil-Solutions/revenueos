import Link from "next/link";
import { DonutChart } from "@/components/donut-chart";
import { StatTile } from "@/components/stat-tile";
import { StatusBadge } from "@/components/status-badge";
import { TrendChart } from "@/components/trend-chart";
import { formatTimestamp, inr, monthLabel, thisMonth } from "@/lib/format";
import {
  dashboardStats,
  documentStatusBreakdown,
  receivablesTrend,
} from "@/lib/reports";
import type { DocumentWithParty } from "@/lib/types";
import { requireBook } from "@/lib/dal";

export const dynamic = "force-dynamic";

function greeting(): string {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}

export default async function DashboardPage() {
  const { user, book } = await requireBook();

  const month = thisMonth();
  const stats = dashboardStats(book, month);
  const trend = receivablesTrend(book, month, 4);
  const docStatus = documentStatusBreakdown(book);
  const recent = book.all<DocumentWithParty>(
    `SELECT d.*, p.name AS party_name, p.kind AS party_kind, p.state_code AS party_state_code
     FROM documents d
     JOIN parties p ON p.id = d.party_id AND p.company_id = @company_id
     WHERE d.company_id = @company_id
     ORDER BY d.id DESC LIMIT 8`
  );

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight">
            {greeting()}, {user.username}
          </h1>
          <p className="mt-1 text-[13.5px] text-ink-3">
            Receivables, GST position, and what needs your review.
          </p>
        </div>
        <Link href="/capture" className="btn">
          Capture a page
        </Link>
      </div>

      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="Receivables"
          value={inr(stats.receivables_paise)}
          sub="Total outstanding"
        />
        <StatTile
          label={`GST payable · ${monthLabel(month)}`}
          value={inr(stats.gst_payable_paise)}
          sub="Net liability"
        />
        <StatTile
          label="Pages pending review"
          value={String(stats.pending_review)}
          sub="Needs your attention"
        />
        <StatTile
          label="Journals this month"
          value={String(stats.journals_this_month)}
          sub="Entries posted"
        />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-12">
        <section className="card flex flex-col p-5 lg:col-span-7">
          <div className="flex items-baseline justify-between">
            <h2 className="text-[13.5px] font-semibold">Receivables trend</h2>
            {/* Names its own cut-off: the tile above is the all-time control
                total, so a book carrying future-dated entries shows a higher
                figure there than this series ends on. Stating the basis stops
                that reading as the books disagreeing with themselves. */}
            <span className="text-[11.5px] text-ink-3">
              Closing balance · through {monthLabel(month)}
            </span>
          </div>
          <div className="mt-3 flex flex-1 flex-col justify-center">
            <TrendChart points={trend} />
          </div>
        </section>

        <section className="card flex flex-col p-5 lg:col-span-5">
          <h2 className="text-[13.5px] font-semibold">Document status</h2>
          <div className="mt-3 flex flex-1 flex-col justify-center">
            <DonutChart slices={docStatus} />
          </div>
        </section>
      </div>

      <div className="mt-6">
        <div className="mb-3 flex items-center justify-between">
          <p className="text-[13.5px] font-semibold">Recent activity</p>
          <Link href="/documents" className="text-[12.5px] font-medium text-accent hover:opacity-80">
            All documents
          </Link>
        </div>
        {recent.length === 0 ? (
          <div className="card px-6 py-14 text-center">
            <p className="text-[13.5px] font-medium text-ink-2">Nothing here yet</p>
            <p className="mt-1 text-[12.5px] text-ink-3">
              Photograph a ledger page and the pipeline starts: extract → review → post → reports.
            </p>
            <Link href="/capture" className="btn mt-4 inline-flex">
              Capture your first page
            </Link>
          </div>
        ) : (
          <div className="card overflow-x-auto">
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
