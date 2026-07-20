"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { PartyRow } from "@/lib/types";

const field =
  "w-full rounded-lg border border-hairline bg-surface-2 px-3 py-2 text-[13.5px] text-ink outline-none focus:border-accent";

/** CSV template upload → /api/import/excel → straight to the review screen.
 * The picked party is the document's default; the CSV's party column
 * overrides it per row. */
export function ImportExcel({ parties }: { parties: PartyRow[] }) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [partyId, setPartyId] = useState(parties[0]?.id ?? 0);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const picked = e.target.files?.[0] ?? null;
    if (fileRef.current) fileRef.current.value = "";
    setError("");
    setFile(picked);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!file || busy) return;
    setBusy(true);
    setError("");
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("party_id", String(partyId));
      const res = await fetch("/api/import/excel", { method: "POST", body: form });
      const body = (await res.json()) as { id?: number; error?: string };
      if (!res.ok || !body.id) {
        setError(body.error ?? `Import failed (${res.status}).`);
        setBusy(false);
        return;
      }
      router.push(`/documents/${body.id}`);
    } catch {
      setError("Import failed — is the server reachable?");
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <div>
        <label
          className="mb-1.5 block text-[12.5px] font-medium text-ink-3"
          htmlFor="import-party"
        >
          Default party (rows with a blank party column)
        </label>
        <select
          id="import-party"
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

      <input
        ref={fileRef}
        id="import-file"
        type="file"
        accept=".csv,text/csv"
        className="hidden"
        onChange={onPick}
      />
      <label
        htmlFor="import-file"
        className="flex cursor-pointer flex-col items-center gap-1.5 rounded-xl border border-dashed border-hairline bg-surface-2/40 px-6 py-8 text-center transition-colors hover:border-accent/40"
      >
        <svg
          viewBox="0 0 24 24"
          className="size-6 stroke-accent"
          fill="none"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M12 3v12M7 10l5 5 5-5" />
          <path d="M4 17v3h16v-3" />
        </svg>
        <span className="text-[13.5px] font-medium text-ink-2">
          {file ? file.name : "Choose the filled-in CSV"}
        </span>
        <span className="text-[12px] text-ink-3">
          From Excel or Sheets: File → Save As → CSV
        </span>
      </label>

      {error && (
        <p className="rounded-lg border border-critical/40 bg-critical/10 px-3 py-2 text-[12.5px] text-critical">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={busy || !file}
        className="rounded-lg bg-accent px-4 py-2.5 text-[13px] font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {busy ? "Importing…" : "Import to review"}
      </button>
    </form>
  );
}
