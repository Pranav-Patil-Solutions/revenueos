import Link from "next/link";
import { UploadCapture } from "@/components/upload-capture";
import type { PartyRow } from "@/lib/types";
import { requireBook } from "@/lib/dal";

export const dynamic = "force-dynamic";

export default async function CapturePage() {
  const { book } = await requireBook();

  const parties = book.all<PartyRow>(
    "SELECT * FROM parties WHERE company_id = @company_id ORDER BY name COLLATE NOCASE"
  );

  return (
    <div>
      <h1 className="text-[22px] font-semibold tracking-tight">Capture</h1>
      <p className="mt-1 text-[13.5px] text-ink-3">
        Photograph a ledger page and send it for extraction.
      </p>

      <div className="mt-6 max-w-xl">
        {parties.length === 0 ? (
          <div className="rounded-xl border border-hairline bg-surface px-6 py-14 text-center">
            <p className="text-[13.5px] font-medium text-ink-2">
              Add a party first
            </p>
            <p className="mt-1 text-[12.5px] text-ink-3">
              Every ledger page belongs to a customer or supplier.
            </p>
            <Link
              href="/parties"
              className="mt-4 inline-block rounded-lg bg-accent px-4 py-2 text-[13px] font-medium text-white transition-opacity hover:opacity-90"
            >
              Go to Parties
            </Link>
          </div>
        ) : (
          <UploadCapture parties={parties} />
        )}
      </div>

      <p className="mt-4 max-w-xl text-[12px] leading-relaxed text-ink-3">
        Capturing from your phone? Open this page over Tailscale —
        http://&lt;tailscale-ip&gt;:3322/capture — and the file picker opens
        the camera directly.
      </p>
    </div>
  );
}
