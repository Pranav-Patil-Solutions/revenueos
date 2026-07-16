import Link from "next/link";
import { getDb } from "@/lib/db";
import { StatusBadge } from "@/components/status-badge";
import { formatTimestamp } from "@/lib/format";
import type { DocumentWithParty } from "@/lib/types";

export const dynamic = "force-dynamic";

export default function DocumentsPage() {
  const docs = getDb()
    .prepare(
      `SELECT d.*, p.name AS party_name, p.kind AS party_kind, p.state_code AS party_state_code
       FROM documents d JOIN parties p ON p.id = d.party_id
       ORDER BY d.id DESC`
    )
    .all() as DocumentWithParty[];

  return (
    <div>
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight">Documents</h1>
          <p className="mt-1 text-[13.5px] text-ink-3">
            Every captured ledger page and where it is in the pipeline.
          </p>
        </div>
        <Link
          href="/capture"
          className="rounded-lg bg-accent px-4 py-2 text-[13px] font-medium text-white transition-opacity hover:opacity-90"
        >
          Capture a page
        </Link>
      </div>

      {docs.length === 0 ? (
        <div className="mt-6 rounded-xl border border-hairline bg-surface px-6 py-14 text-center">
          <p className="text-[13.5px] font-medium text-ink-2">No documents yet</p>
          <p className="mt-1 text-[12.5px] text-ink-3">
            Capture a ledger page and it will land here.
          </p>
        </div>
      ) : (
        <div className="mt-6 overflow-x-auto rounded-xl border border-hairline bg-surface">
          <table className="w-full text-left text-[13px]">
            <thead>
              <tr className="border-b border-hairline text-[11.5px] uppercase tracking-wide text-ink-3">
                <th className="px-5 py-3 font-medium">Page</th>
                <th className="px-5 py-3 font-medium">Party</th>
                <th className="px-5 py-3 font-medium">Status</th>
                <th className="px-5 py-3 font-medium">Note</th>
                <th className="px-5 py-3 text-right font-medium">Captured</th>
                <th className="px-5 py-3" />
              </tr>
            </thead>
            <tbody style={{ fontVariantNumeric: "tabular-nums" }}>
              {docs.map((d) => (
                <tr
                  key={d.id}
                  className="border-b border-hairline/60 last:border-0 hover:bg-surface-2/50"
                >
                  <td className="px-5 py-3.5">
                    <Link
                      href={`/documents/${d.id}`}
                      className="flex items-center gap-3 font-medium text-ink hover:text-accent"
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={`/api/uploads/${d.id}`}
                        alt=""
                        className="size-9 rounded-md border border-hairline object-cover"
                      />
                      #{d.id}
                    </Link>
                  </td>
                  <td className="px-5 py-3.5 text-ink-2">{d.party_name}</td>
                  <td className="px-5 py-3.5">
                    <StatusBadge status={d.status} />
                  </td>
                  <td className="max-w-72 truncate px-5 py-3.5 text-ink-3">
                    {d.status === "failed" ? d.error : ""}
                  </td>
                  <td className="px-5 py-3.5 text-right text-ink-3">
                    {formatTimestamp(d.created_at)}
                  </td>
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
  );
}
