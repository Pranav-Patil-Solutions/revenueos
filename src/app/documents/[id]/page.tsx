import Link from "next/link";
import { notFound } from "next/navigation";
import { deleteDocument, runExtraction } from "@/lib/actions";
import { AutoRefresh } from "@/components/auto-refresh";
import { LedgerImage } from "@/components/ledger-image";
import { ReviewTable } from "@/components/review-table";
import { StatusBadge } from "@/components/status-badge";
import { formatTimestamp } from "@/lib/format";
import type { DocumentWithParty, StagedRow } from "@/lib/types";
import { requireBook } from "@/lib/dal";

export const dynamic = "force-dynamic";

export default async function DocumentReviewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { book } = await requireBook();

  const { id } = await params;
  const doc = book.get(
    `SELECT d.*, p.name AS party_name, p.kind AS party_kind, p.state_code AS party_state_code
     FROM documents d
     JOIN parties p ON p.id = d.party_id AND p.company_id = @company_id
     WHERE d.id = @id AND d.company_id = @company_id`,
    { id: Number(id) }
  ) as DocumentWithParty | undefined;
  if (!doc) notFound();

  const rows = book.all<StagedRow>(
    "SELECT * FROM staged_rows WHERE document_id = @docId AND company_id = @company_id ORDER BY row_no",
    { docId: doc.id }
  );
  const isPhoto = doc.source_type === "photo";
  // Imports carry a party per row — the review grid shows who each row books to.
  const partyNames = isPhoto
    ? undefined
    : Object.fromEntries(
        book
          .all<{ id: number; name: string }>(
            "SELECT id, name FROM parties WHERE company_id = @company_id"
          )
          .map((p) => [p.id, p.name])
      );
  const duplicateOf = book.get(
    `SELECT id FROM documents
     WHERE company_id = @company_id AND image_sha256 = @sha256 AND id < @docId
     ORDER BY id LIMIT 1`,
    { sha256: doc.image_sha256, docId: doc.id }
  ) as { id: number } | undefined;

  const extractAction = runExtraction.bind(null, doc.id);
  const deleteAction = deleteDocument.bind(null, doc.id);
  const busy = doc.status === "extracting" || (doc.status === "uploaded" && rows.length === 0);

  return (
    <div>
      {doc.status === "extracting" && <AutoRefresh />}
      {doc.status === "uploaded" && <AutoRefresh intervalMs={3000} />}

      <div className="flex items-center justify-between">
        <div>
          <h1 className="flex items-center gap-3 text-[22px] font-semibold tracking-tight">
            Page #{doc.id}
            <StatusBadge status={doc.status} />
          </h1>
          <p className="mt-1 text-[13.5px] text-ink-3">
            {doc.party_name} · {doc.party_kind} ·{" "}
            {isPhoto ? "captured" : `imported from ${doc.source_type}`}{" "}
            {formatTimestamp(doc.created_at)}
            {isPhoto && doc.model ? ` · extracted by ${doc.model}` : ""}
          </p>
        </div>
        <div className="flex items-center gap-4">
          {doc.status !== "posted" && (
            <form action={deleteAction}>
              <button
                type="submit"
                className="text-[12.5px] font-medium text-ink-3 hover:text-critical"
              >
                Delete
              </button>
            </form>
          )}
          <Link
            href="/documents"
            className="text-[12.5px] font-medium text-accent hover:opacity-80"
          >
            All documents
          </Link>
        </div>
      </div>

      {duplicateOf && doc.status !== "posted" && (
        <div className="mt-4 rounded-lg border border-warning/40 bg-warning/10 px-4 py-2.5 text-[12.5px] text-warning">
          This {isPhoto ? "photo" : "file"} is byte-identical to page{" "}
          <Link href={`/documents/${duplicateOf.id}`} className="font-semibold underline">
            #{duplicateOf.id}
          </Link>{" "}
          — posting both would double-count the entries.
        </div>
      )}
      {doc.status === "posted" && (
        <div className="mt-4 rounded-lg border border-good/40 bg-good/10 px-4 py-2.5 text-[12.5px] text-good">
          Posted {formatTimestamp(doc.posted_at)} — rows are read-only. Corrections are
          made fix-forward with an opposite entry.
        </div>
      )}
      {doc.status === "failed" && (
        <div className="mt-4 flex items-center justify-between gap-4 rounded-lg border border-critical/40 bg-critical/10 px-4 py-2.5">
          <p className="text-[12.5px] text-critical">
            Extraction failed: {doc.error || "unknown error"}
          </p>
          <form action={extractAction}>
            <button
              type="submit"
              className="shrink-0 rounded-lg bg-accent px-3 py-1.5 text-[12.5px] font-medium text-white hover:opacity-90"
            >
              Retry extraction
            </button>
          </form>
        </div>
      )}

      <div
        className={
          isPhoto
            ? "mt-6 grid gap-6 lg:grid-cols-[minmax(260px,340px)_1fr]"
            : "mt-6"
        }
      >
        {isPhoto && (
          <div className="lg:sticky lg:top-8 lg:self-start">
            <LedgerImage documentId={doc.id} />
            {doc.status === "extracted" && (
              <form action={extractAction} className="mt-3">
                <button
                  type="submit"
                  className="w-full rounded-lg border border-hairline bg-surface px-3 py-2 text-[12.5px] font-medium text-ink-2 transition-colors hover:text-ink"
                >
                  Re-extract from photo
                </button>
              </form>
            )}
          </div>
        )}

        <div className="min-w-0">
          {busy ? (
            <div className="rounded-xl border border-hairline bg-surface px-6 py-14 text-center">
              <p className="text-[13.5px] font-medium text-ink-2">
                Reading the ledger page…
              </p>
              <p className="mt-1 text-[12.5px] text-ink-3">
                The extracted rows will appear here for review. This can take a
                minute or two on a real photo.
              </p>
            </div>
          ) : rows.length === 0 ? (
            <div className="rounded-xl border border-hairline bg-surface px-6 py-14 text-center">
              <p className="text-[13.5px] font-medium text-ink-2">
                No rows {isPhoto ? "extracted" : "imported"} yet
              </p>
              <p className="mt-1 text-[12.5px] text-ink-3">
                {isPhoto
                  ? "Run extraction to read this page into editable rows."
                  : "The file had no usable rows — fix it and import again."}
              </p>
              {isPhoto && (
                <form action={extractAction} className="mt-4">
                  <button
                    type="submit"
                    className="rounded-lg bg-accent px-4 py-2 text-[13px] font-medium text-white transition-opacity hover:opacity-90"
                  >
                    Run extraction
                  </button>
                </form>
              )}
            </div>
          ) : (
            <ReviewTable
              docId={doc.id}
              rows={rows}
              readOnly={doc.status === "posted"}
              partyNames={partyNames}
              defaultPartyName={isPhoto ? undefined : doc.party_name}
            />
          )}
        </div>
      </div>
    </div>
  );
}
