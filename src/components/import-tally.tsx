"use client";

import { useRef, useState } from "react";
import { createTallyImport } from "@/lib/actions";
import type { PartyRow } from "@/lib/types";

const field =
  "w-full rounded-lg border border-hairline bg-surface-2 px-3 py-2 text-[13.5px] text-ink outline-none focus:border-accent";

interface AccountOption {
  id: number;
  code: string;
  name: string;
}

interface UnmappedLedger {
  ledger_name: string;
  suggestion: { target_kind: "account" | "party"; id: number } | null;
}

interface Preview {
  token: string;
  vouchers: number;
  unmapped: UnmappedLedger[];
  duplicate_of: number | null;
}

/**
 * Two steps: read the Day Book, then map whatever ledgers this book hasn't
 * seen before. Mappings are saved with the import, so a second Day Book from
 * the same Tally company asks nothing and goes straight to review.
 */
export function ImportTally({
  parties,
  accounts,
}: {
  parties: PartyRow[];
  accounts: AccountOption[];
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [partyId, setPartyId] = useState(parties[0]?.id ?? 0);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const picked = e.target.files?.[0] ?? null;
    if (fileRef.current) fileRef.current.value = "";
    setError("");
    setFile(picked);
  }

  async function readDayBook(e: React.FormEvent) {
    e.preventDefault();
    if (!file || busy) return;
    setBusy(true);
    setError("");
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/import/tally/preview", {
        method: "POST",
        body: form,
      });
      const body = (await res.json()) as Partial<Preview> & { error?: string };
      if (!res.ok || !body.token) {
        setError(body.error ?? `Could not read that file (${res.status}).`);
        setBusy(false);
        return;
      }
      setPreview(body as Preview);
    } catch {
      setError("Upload failed — is the server reachable?");
    }
    setBusy(false);
  }

  function startOver() {
    setPreview(null);
    setFile(null);
    setError("");
  }

  if (preview) {
    return (
      // Keyed apart from the pick form: without it React reconciles the two
      // forms' <input>s by position and flips the uncontrolled file input into
      // a controlled hidden one.
      <form key="map" action={createTallyImport} className="flex flex-col gap-4">
        <input type="hidden" name="token" value={preview.token} />
        <input type="hidden" name="party_id" value={partyId} />

        <p className="text-[12.5px] text-ink-3">
          <span className="font-medium text-ink-2">
            {preview.vouchers} voucher{preview.vouchers === 1 ? "" : "s"}
          </span>{" "}
          read from the day book.
          {preview.unmapped.length === 0
            ? " Every ledger is already mapped."
            : ` ${preview.unmapped.length} ledger${
                preview.unmapped.length === 1 ? "" : "s"
              } need a home — this is asked once.`}
        </p>

        {preview.duplicate_of !== null && (
          <p className="rounded-lg border border-hairline bg-surface-2/60 px-3 py-2 text-[12.5px] text-ink-3">
            These exact bytes came in before as document #{preview.duplicate_of}
            . Importing again will stage the vouchers a second time.
          </p>
        )}

        {preview.unmapped.length > 0 && (
          <div className="flex flex-col divide-y divide-hairline rounded-lg border border-hairline">
            {preview.unmapped.map((u) => (
              <div
                key={u.ledger_name}
                className="grid items-center gap-3 px-3 py-2.5 sm:grid-cols-[1fr_1.2fr]"
              >
                <span className="truncate text-[13px] font-medium text-ink-2">
                  {u.ledger_name}
                </span>
                <select
                  name={`map:${u.ledger_name}`}
                  required
                  defaultValue={
                    u.suggestion
                      ? `${u.suggestion.target_kind}:${u.suggestion.id}`
                      : ""
                  }
                  className={field}
                >
                  <option value="">Choose a party or account…</option>
                  <optgroup label="Parties">
                    {parties.map((p) => (
                      <option key={p.id} value={`party:${p.id}`}>
                        {p.name} · {p.kind}
                      </option>
                    ))}
                  </optgroup>
                  <optgroup label="Accounts">
                    {accounts.map((a) => (
                      <option key={a.id} value={`account:${a.id}`}>
                        {a.code} · {a.name}
                      </option>
                    ))}
                  </optgroup>
                </select>
              </div>
            ))}
          </div>
        )}

        <div className="flex items-center gap-2">
          <button
            type="submit"
            className="rounded-lg bg-accent px-4 py-2.5 text-[13px] font-medium text-white transition-opacity hover:opacity-90"
          >
            Stage vouchers for review
          </button>
          <button
            type="button"
            onClick={startOver}
            className="rounded-lg px-3 py-2.5 text-[13px] font-medium text-ink-3 hover:text-ink"
          >
            Start over
          </button>
        </div>
      </form>
    );
  }

  return (
    <form key="pick" onSubmit={readDayBook} className="flex flex-col gap-4">
      <div>
        <label
          className="mb-1.5 block text-[12.5px] font-medium text-ink-3"
          htmlFor="tally-party"
        >
          Default party (vouchers without one of their own)
        </label>
        <select
          id="tally-party"
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
        id="tally-file"
        type="file"
        accept=".xml,text/xml,application/xml"
        className="hidden"
        onChange={onPick}
      />
      <label
        htmlFor="tally-file"
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
          {file ? file.name : "Choose the Day Book XML"}
        </span>
        <span className="text-[12px] text-ink-3">
          In Tally: Display → Day Book → Alt+E → XML
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
        {busy ? "Reading…" : "Read the day book"}
      </button>
    </form>
  );
}
