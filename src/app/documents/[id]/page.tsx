import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/lib/db";
import { LedgerImage } from "@/components/ledger-image";
import { StatusBadge } from "@/components/status-badge";
import { formatTimestamp } from "@/lib/format";
import type { DocumentWithParty } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function DocumentReviewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const doc = getDb()
    .prepare(
      `SELECT d.*, p.name AS party_name, p.kind AS party_kind, p.state_code AS party_state_code
       FROM documents d JOIN parties p ON p.id = d.party_id
       WHERE d.id = ?`
    )
    .get(Number(id)) as DocumentWithParty | undefined;
  if (!doc) notFound();

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="flex items-center gap-3 text-[22px] font-semibold tracking-tight">
            Page #{doc.id}
            <StatusBadge status={doc.status} />
          </h1>
          <p className="mt-1 text-[13.5px] text-ink-3">
            {doc.party_name} · {doc.party_kind} · captured{" "}
            {formatTimestamp(doc.created_at)}
          </p>
        </div>
        <Link
          href="/documents"
          className="text-[12.5px] font-medium text-accent hover:opacity-80"
        >
          All documents
        </Link>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(280px,380px)_1fr]">
        <div className="lg:sticky lg:top-8 lg:self-start">
          <LedgerImage documentId={doc.id} />
        </div>

        <div className="rounded-xl border border-hairline bg-surface px-6 py-14 text-center">
          <p className="text-[13.5px] font-medium text-ink-2">
            Extraction lands in the next phase
          </p>
          <p className="mt-1 text-[12.5px] text-ink-3">
            The editable review grid will appear here.
          </p>
        </div>
      </div>
    </div>
  );
}
