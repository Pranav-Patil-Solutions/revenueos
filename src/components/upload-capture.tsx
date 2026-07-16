"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { PartyRow } from "@/lib/types";

const field =
  "w-full rounded-lg border border-hairline bg-surface-2 px-3 py-2 text-[13.5px] text-ink outline-none focus:border-accent";

/**
 * File-input capture (not getUserMedia): on phones, capture="environment"
 * opens the camera directly, and it works over plain-HTTP LAN/Tailscale where
 * getUserMedia would demand a secure context.
 */
export function UploadCapture({ parties }: { parties: PartyRow[] }) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [partyId, setPartyId] = useState(parties[0]?.id ?? 0);
  const [fileName, setFileName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const file = fileRef.current?.files?.[0];
    if (!file || busy) return;
    setBusy(true);
    setError("");
    try {
      const form = new FormData();
      form.append("file", file);
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

        <label
          className={`flex cursor-pointer flex-col items-center gap-2 rounded-xl border border-dashed px-6 py-10 text-center transition-colors ${
            fileName
              ? "border-accent/60 bg-accent-soft"
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
            {fileName || "Take a photo or choose an image"}
          </span>
          <span className="text-[12px] text-ink-3">
            JPG, PNG, or WEBP · up to 15MB · HEIC not supported (use the Most
            Compatible camera setting)
          </span>
          <input
            ref={fileRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            capture="environment"
            className="hidden"
            onChange={(e) => setFileName(e.target.files?.[0]?.name ?? "")}
          />
        </label>

        {error && (
          <p className="rounded-lg border border-critical/40 bg-critical/10 px-3 py-2 text-[12.5px] text-critical">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={busy || !fileName}
          className="rounded-lg bg-accent px-4 py-2.5 text-[13px] font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? "Uploading…" : "Upload & extract"}
        </button>
      </div>
    </form>
  );
}
