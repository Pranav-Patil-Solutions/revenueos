"use client";

import { useState } from "react";

/** The captured ledger photo — sticky beside the review grid, click to zoom
 * into a full-screen lightbox for reading faint handwriting. */
export function LedgerImage({ documentId }: { documentId: number }) {
  const [zoomed, setZoomed] = useState(false);
  const src = `/api/uploads/${documentId}`;

  return (
    <>
      <button
        type="button"
        onClick={() => setZoomed(true)}
        className="block w-full cursor-zoom-in overflow-hidden rounded-xl border border-hairline bg-surface"
        title="Click to zoom"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={src} alt="Captured ledger page" className="w-full" />
      </button>

      {zoomed && (
        <div
          className="fixed inset-0 z-50 cursor-zoom-out overflow-auto bg-black/85 p-6"
          onClick={() => setZoomed(false)}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={src}
            alt="Captured ledger page, zoomed"
            className="mx-auto min-w-[900px] max-w-none lg:min-w-[1400px]"
          />
        </div>
      )}
    </>
  );
}
