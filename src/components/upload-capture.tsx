"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { PartyRow } from "@/lib/types";

const field =
  "w-full rounded-lg border border-hairline bg-surface-2 px-3 py-2 text-[13.5px] text-ink outline-none focus:border-accent";

// Long edge we downscale to before upload. 2400px keeps ledger digits crisp for
// the vision model while cutting a 12MP phone shot from ~4MB to a few hundred KB.
const MAX_EDGE = 2400;
const JPEG_QUALITY = 0.85;

type Processed = {
  previewUrl: string;
  blob: Blob;
  width: number;
  height: number;
  originalBytes: number;
};

/**
 * File-input capture (not getUserMedia): on phones, capture="environment"
 * opens the camera directly, and it works over plain-HTTP LAN/Tailscale where
 * getUserMedia would demand a secure context.
 *
 * Every picked image is normalised in the browser before upload — decoded,
 * downscaled to MAX_EDGE, EXIF orientation baked into the pixels, and re-encoded
 * to JPEG. That converts iPhone HEIC (decoded natively by iOS Safari), shrinks
 * the upload, and guarantees the server/vision model gets upright RGB pixels.
 */
export function UploadCapture({ parties }: { parties: PartyRow[] }) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [partyId, setPartyId] = useState(parties[0]?.id ?? 0);
  const [processing, setProcessing] = useState(false);
  const [shot, setShot] = useState<Processed | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // Revoke the preview object URL when it is replaced or the component unmounts.
  useEffect(() => {
    return () => {
      if (shot) URL.revokeObjectURL(shot.previewUrl);
    };
  }, [shot]);

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    // Allow re-picking the same file next time by clearing the input value.
    if (fileRef.current) fileRef.current.value = "";
    if (!file) return;
    setError("");
    setProcessing(true);
    try {
      const { blob, width, height } = await normaliseImage(file);
      // Create the object URL once, outside the updater below — React 18 Strict
      // Mode double-invokes setState updaters in dev, and calling
      // createObjectURL inside one leaks a URL that's never referenced or
      // revoked.
      const previewUrl = URL.createObjectURL(blob);
      setShot((prev) => {
        if (prev) URL.revokeObjectURL(prev.previewUrl);
        return { previewUrl, blob, width, height, originalBytes: file.size };
      });
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Could not read that photo — retake it."
      );
    } finally {
      setProcessing(false);
    }
  }

  function retake() {
    setError("");
    setShot((prev) => {
      if (prev) URL.revokeObjectURL(prev.previewUrl);
      return null;
    });
    fileRef.current?.click();
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!shot || busy) return;
    setBusy(true);
    setError("");
    try {
      const form = new FormData();
      form.append(
        "file",
        new File([shot.blob], "capture.jpg", { type: "image/jpeg" })
      );
      form.append("party_id", String(partyId));
      const res = await fetch("/api/upload", { method: "POST", body: form });
      const body = (await res.json()) as { id?: number; error?: string };
      if (!res.ok || !body.id) {
        setError(body.error ?? `Upload failed (${res.status}).`);
        setBusy(false);
        return;
      }
      // Kick off extraction in the background; the review page shows progress
      // and offers a retry, so a failure here is non-fatal.
      fetch(`/api/documents/${body.id}/extract`, { method: "POST" }).catch(
        () => {}
      );
      router.push(`/documents/${body.id}`);
    } catch {
      setError("Upload failed — is the server reachable?");
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      className="rounded-xl border border-hairline bg-surface p-5"
    >
      <div className="flex flex-col gap-4">
        <div>
          <label
            className="mb-1.5 block text-[12.5px] font-medium text-ink-3"
            htmlFor="party"
          >
            Whose ledger page is this?
          </label>
          <select
            id="party"
            value={partyId}
            onChange={(e) => setPartyId(Number(e.target.value))}
            className={field}
          >
            {parties.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} · {p.kind}
              </option>
            ))}
          </select>
        </div>

        {/* Always mounted (not just in the "no shot yet" branch) so retake()'s
            fileRef.current?.click() has a live node to call — it used to fire
            against a stale null ref while the preview was showing. Associated
            with the picker tile below via htmlFor instead of physical nesting. */}
        <input
          ref={fileRef}
          id="capture-input"
          type="file"
          accept="image/*"
          capture="environment"
          className="hidden"
          disabled={processing}
          onChange={onPick}
        />
        {shot ? (
          <div className="flex flex-col gap-3">
            <div className="overflow-hidden rounded-xl border border-hairline bg-surface-2">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={shot.previewUrl}
                alt="Captured ledger page"
                className="max-h-[52vh] w-full object-contain"
              />
            </div>
            <div className="flex items-center justify-between text-[12px] text-ink-3">
              <span>
                {shot.width}×{shot.height} · {formatBytes(shot.blob.size)}
                {shot.originalBytes > shot.blob.size && (
                  <span className="text-ink-3/70">
                    {" "}
                    (from {formatBytes(shot.originalBytes)})
                  </span>
                )}
              </span>
              <button
                type="button"
                onClick={retake}
                disabled={busy}
                className="font-medium text-accent transition-opacity hover:opacity-80 disabled:opacity-40"
              >
                Retake
              </button>
            </div>
          </div>
        ) : (
          <label
            htmlFor="capture-input"
            className={`flex cursor-pointer flex-col items-center gap-2 rounded-xl border border-dashed px-6 py-10 text-center transition-colors ${
              processing
                ? "border-accent/40 bg-accent-soft"
                : "border-hairline bg-surface-2/40 hover:border-accent/40"
            }`}
          >
            <svg
              viewBox="0 0 24 24"
              className="size-6 stroke-accent"
              fill="none"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M4 8h3l2-3h6l2 3h3v11H4z" />
              <circle cx="12" cy="13" r="3.5" />
            </svg>
            <span className="text-[13.5px] font-medium text-ink-2">
              {processing ? "Preparing photo…" : "Take a photo or choose an image"}
            </span>
            <span className="text-[12px] text-ink-3">
              iPhone HEIC is handled automatically · downscaled &amp; compressed
              before upload
            </span>
          </label>
        )}

        {error && (
          <p className="rounded-lg border border-critical/40 bg-critical/10 px-3 py-2 text-[12.5px] text-critical">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={busy || processing || !shot}
          className="rounded-lg bg-accent px-4 py-2.5 text-[13px] font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? "Uploading…" : "Upload & extract"}
        </button>
      </div>
    </form>
  );
}

/**
 * Decode any browser-readable image (incl. iOS-native HEIC), downscale to
 * MAX_EDGE, bake EXIF orientation into the pixels, and re-encode as JPEG.
 * The <img> + object-URL path is the most compatible decoder and is the only
 * route that reliably renders HEIC on iOS Safari.
 */
async function normaliseImage(
  file: File
): Promise<{ blob: Blob; width: number; height: number }> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      // Some truncated files / odd HEIC variants fire neither onload nor
      // onerror — without a timeout that leaves "processing" stuck forever.
      const timer = setTimeout(() => {
        reject(new Error("That photo took too long to load. Retake it, or try a different file."));
      }, 15000);
      el.onload = () => {
        clearTimeout(timer);
        resolve(el);
      };
      el.onerror = () => {
        clearTimeout(timer);
        reject(
          new Error(
            "That file isn't a readable image. Retake the photo, or share it as JPEG."
          )
        );
      };
      el.src = url;
    });

    // Modern browsers default to image-orientation: from-image, so naturalWidth/
    // Height and drawImage already reflect the EXIF-corrected orientation.
    const srcW = img.naturalWidth;
    const srcH = img.naturalHeight;
    if (!srcW || !srcH) {
      throw new Error("Could not read that photo — retake it.");
    }

    const scale = Math.min(1, MAX_EDGE / Math.max(srcW, srcH));
    const w = Math.max(1, Math.round(srcW * scale));
    const h = Math.max(1, Math.round(srcH * scale));

    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Your browser blocked image processing.");
    // JPEG has no alpha channel — seed an opaque white background so transparent
    // source pixels (e.g. a PNG screenshot) don't composite to black on encode.
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, w, h);
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, 0, 0, w, h);

    // The re-encode is mandatory (it bakes EXIF orientation into pixels and
    // normalises HEIC), but the aggressive quality target only exists to trade
    // fidelity for a smaller upload when we're actually downscaling. When the
    // source was already within MAX_EDGE, there's no size pressure — encode
    // near-lossless instead of needlessly recompressing a clean image.
    const quality = scale < 1 ? JPEG_QUALITY : 0.95;
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", quality)
    );
    if (!blob) throw new Error("Could not process that photo — retake it.");
    return { blob, width: w, height: h };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
