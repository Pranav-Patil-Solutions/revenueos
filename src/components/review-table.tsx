"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import { saveAndPost, saveDraftRows } from "@/lib/actions";
import { inr } from "@/lib/format";
import {
  countEmptyDates,
  findMissingDateIndices,
  fillEmptyDates as bulkFillEmptyDates,
  missingDatesText as deriveMissingDatesText,
} from "@/lib/review-dates";
import { ConfidenceBadge } from "./status-badge";
import type { EntryType, StagedRow } from "@/lib/types";

const ENTRY_TYPES: EntryType[] = [
  "sale",
  "receipt",
  "purchase",
  "payment",
  "credit_note",
  "debit_note",
  "opening",
  "other",
];
const RATES = ["", "0", "5", "12", "18", "28"];

interface EditRow {
  id: number;
  row_no: number;
  party_id: number | null;
  entry_date: string; // "" = null
  particulars: string;
  ref_no: string;
  debit: string; // rupees as typed
  credit: string;
  entry_type: EntryType;
  gst_rate: string; // "" = null
  bank_account_id: number;
  include: boolean;
  confidence: number;
  is_balance_row: boolean;
}

const cellInput =
  "w-full rounded-md border border-transparent bg-transparent px-1.5 py-1 text-[12.5px] text-ink outline-none hover:border-hairline focus:border-accent focus:bg-surface-2";

// Date cell uses its own base (no cellInput) so the invalid border-color isn't
// fighting cellInput's border-transparent for CSS source-order precedence.
const dateBase =
  "w-32 rounded-md border px-1.5 py-1 text-[12.5px] text-ink outline-none";
const dateOk =
  "border-transparent bg-transparent hover:border-hairline focus:border-accent focus:bg-surface-2";
const dateBad = "border-critical bg-critical/10 focus:border-critical";

function paiseToInput(paise: number | null): string {
  return paise === null ? "" : (paise / 100).toFixed(2);
}

function inputToPaise(s: string): number | null {
  const t = s.trim();
  if (t === "") return null;
  const n = Number(t);
  if (!Number.isFinite(n) || n < 0) return null;
  const paise = Math.round(n * 100);
  return paise === 0 ? null : paise;
}

export function ReviewTable({
  docId,
  rows,
  readOnly,
  bankAccounts,
  partyNames,
  defaultPartyName,
}: {
  docId: number;
  rows: StagedRow[];
  readOnly: boolean;
  /** The book's active cash/bank/wallet accounts, for the settlement column.
   * Ingestion resolved a coarse cash-vs-bank hint to a default; this is where a
   * human corrects it to the account the money actually moved through. */
  bankAccounts: { id: number; name: string }[];
  /** id → name for the per-row party column (imports only). The column is
   * hidden when absent, keeping the photo path's layout untouched. */
  partyNames?: Record<number, string>;
  defaultPartyName?: string;
}) {
  const showParty = partyNames !== undefined;
  // Named per row from the list rather than joined server-side: the review grid
  // is a client component and the account set is small and already loaded.
  const bankAccountName = (id: number): string =>
    bankAccounts.find((ba) => ba.id === id)?.name ?? "—";
  const [edit, setEdit] = useState<EditRow[]>(() =>
    rows.map((r) => ({
      id: r.id,
      row_no: r.row_no,
      party_id: r.party_id,
      entry_date: r.entry_date ?? "",
      particulars: r.particulars,
      ref_no: r.ref_no,
      debit: paiseToInput(r.debit_paise),
      credit: paiseToInput(r.credit_paise),
      entry_type: r.entry_type,
      gst_rate: r.gst_rate === null ? "" : String(r.gst_rate),
      bank_account_id: r.bank_account_id,
      include: r.include === 1,
      confidence: r.confidence,
      is_balance_row: r.is_balance_row === 1,
    }))
  );
  const [pending, startTransition] = useTransition();
  const [notice, setNotice] = useState<{ tone: "good" | "bad"; text: string } | null>(null);
  // Indices of included rows flagged as missing a date by the pre-post check.
  const [missingDates, setMissingDates] = useState<Set<number>>(new Set());
  const dateRefs = useRef<(HTMLInputElement | null)[]>([]);
  // Bill/invoice pages carry one document-level date, not a per-row date, so the
  // model returns nulls for every row. This lets the user stamp one date across
  // all empty rows instead of typing it N times. Left blank by default — a
  // single stray per-row date isn't trustworthy enough to silently reuse.
  const [fillDate, setFillDate] = useState<string>("");

  // Derived from the live missingDates set (not a frozen string) so the banner
  // shrinks in place as the user fixes flagged rows, instead of naming rows
  // that are already resolved.
  const missingDatesText = useMemo(
    () => deriveMissingDatesText(edit, missingDates),
    [missingDates, edit]
  );

  function clearDateFlag(i: number) {
    setMissingDates((prev) => {
      if (!prev.has(i)) return prev;
      const next = new Set(prev);
      next.delete(i);
      return next;
    });
  }

  function fillEmptyDates() {
    if (!fillDate) return;
    setEdit((prev) => bulkFillEmptyDates(prev, fillDate));
    setMissingDates(new Set());
    setNotice(null);
  }

  const totals = useMemo(() => {
    let dr = 0;
    let cr = 0;
    for (const r of edit) {
      if (!r.include) continue;
      dr += inputToPaise(r.debit) ?? 0;
      cr += inputToPaise(r.credit) ?? 0;
    }
    return { dr, cr };
  }, [edit]);

  const emptyDateCount = useMemo(() => countEmptyDates(edit), [edit]);

  // Party is fixed at import time (it decides AR vs AP legs) — display only.
  const partyLabel = (r: EditRow): string =>
    r.party_id === null
      ? defaultPartyName ?? "—"
      : partyNames?.[r.party_id] ?? `#${r.party_id}`;

  function set(i: number, patch: Partial<EditRow>) {
    setEdit((prev) => prev.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  }

  function payload(): string {
    return JSON.stringify(
      edit.map((r) => ({
        id: r.id,
        entry_date: r.entry_date || null,
        particulars: r.particulars,
        ref_no: r.ref_no,
        debit_paise: inputToPaise(r.debit),
        credit_paise: inputToPaise(r.credit),
        entry_type: r.entry_type,
        gst_rate: r.gst_rate === "" ? null : Number(r.gst_rate),
        bank_account_id: r.bank_account_id,
        include: r.include,
      }))
    );
  }

  function onSave() {
    setNotice(null);
    startTransition(async () => {
      try {
        await saveDraftRows(docId, payload());
        setNotice({ tone: "good", text: "Draft saved." });
      } catch (e) {
        setNotice({ tone: "bad", text: e instanceof Error ? e.message : "Save failed." });
      }
    });
  }

  function onPost() {
    const included = edit.filter((r) => r.include);
    if (included.length === 0) {
      setNotice({ tone: "bad", text: "No rows are included — nothing to post." });
      return;
    }
    // Mirror the posting engine's rule: every included row needs a date. Catch
    // it here — with the offending cells highlighted — instead of failing on the
    // server after the confirm dialog.
    const missing = findMissingDateIndices(edit);
    if (missing.length > 0) {
      setMissingDates(new Set(missing));
      dateRefs.current[missing[0]]?.focus();
      return;
    }
    setMissingDates(new Set());
    const ok = window.confirm(
      `Post ${included.length} row${included.length === 1 ? "" : "s"} to the books?\n\nPosting is permanent — corrections are made with an opposite entry, not by editing.`
    );
    if (!ok) return;
    setNotice(null);
    startTransition(async () => {
      try {
        await saveAndPost(docId, payload());
        setNotice({ tone: "good", text: "Posted to the books." });
      } catch (e) {
        setNotice({ tone: "bad", text: e instanceof Error ? e.message : "Posting failed." });
      }
    });
  }

  return (
    <div className="rounded-xl border border-hairline bg-surface">
      {!readOnly && emptyDateCount > 0 && (
        <div className="flex flex-wrap items-center gap-2.5 border-b border-hairline px-4 py-2.5 text-[12.5px]">
          <span className="text-ink-3">
            {emptyDateCount} row{emptyDateCount === 1 ? "" : "s"} missing a date —
            a bill carries one date. Set it once:
          </span>
          <input
            type="date"
            value={fillDate}
            onChange={(e) => setFillDate(e.target.value)}
            className="rounded-md border border-hairline bg-surface-2 px-2 py-1 text-ink outline-none focus:border-accent"
          />
          <button
            type="button"
            onClick={fillEmptyDates}
            disabled={!fillDate}
            className="rounded-md border border-hairline bg-surface-2 px-3 py-1 font-medium text-ink-2 transition-colors hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
          >
            Fill empty dates
          </button>
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[920px] text-left text-[12.5px]">
          <thead>
            <tr className="border-b border-hairline text-[11.5px] uppercase tracking-wide text-ink-3">
              <th className="px-3 py-3 font-medium">#</th>
              <th className="px-2 py-3 font-medium">Date</th>
              <th className="px-2 py-3 font-medium">Particulars</th>
              <th className="px-2 py-3 font-medium">Ref</th>
              {showParty && <th className="px-2 py-3 font-medium">Party</th>}
              <th className="px-2 py-3 text-right font-medium">Debit ₹</th>
              <th className="px-2 py-3 text-right font-medium">Credit ₹</th>
              <th className="px-2 py-3 font-medium">Type</th>
              <th className="px-2 py-3 font-medium">GST</th>
              <th className="px-2 py-3 font-medium">Via</th>
              <th className="px-2 py-3 font-medium">Conf</th>
              <th className="px-3 py-3 text-center font-medium">Post</th>
            </tr>
          </thead>
          <tbody style={{ fontVariantNumeric: "tabular-nums" }}>
            {edit.map((r, i) => (
              <tr
                key={r.id}
                className={`border-b border-hairline/60 last:border-0 ${
                  r.confidence < 0.4 ? "bg-critical/5" : ""
                } ${r.include ? "" : "opacity-45"}`}
              >
                <td className="px-3 py-1.5 text-ink-3">{r.row_no}</td>
                {readOnly ? (
                  <>
                    <td className="px-2 py-1.5 whitespace-nowrap">{r.entry_date || "—"}</td>
                    <td className="max-w-56 truncate px-2 py-1.5">{r.particulars || "—"}</td>
                    <td className="px-2 py-1.5">{r.ref_no || "—"}</td>
                    {showParty && (
                      <td className="max-w-36 truncate px-2 py-1.5 text-ink-2">
                        {partyLabel(r)}
                      </td>
                    )}
                    <td className="px-2 py-1.5 text-right">{r.debit || ""}</td>
                    <td className="px-2 py-1.5 text-right">{r.credit || ""}</td>
                    <td className="px-2 py-1.5">{r.entry_type.replace("_", " ")}</td>
                    <td className="px-2 py-1.5">{r.gst_rate === "" ? "—" : `${r.gst_rate}%`}</td>
                    <td className="px-2 py-1.5">
                      {bankAccountName(r.bank_account_id)}
                    </td>
                  </>
                ) : (
                  <>
                    <td className="px-1 py-1">
                      <input
                        ref={(el) => {
                          dateRefs.current[i] = el;
                        }}
                        type="date"
                        value={r.entry_date}
                        onChange={(e) => {
                          set(i, { entry_date: e.target.value });
                          if (e.target.value) clearDateFlag(i);
                        }}
                        aria-invalid={missingDates.has(i)}
                        className={`${dateBase} ${missingDates.has(i) ? dateBad : dateOk}`}
                      />
                    </td>
                    <td className="px-1 py-1">
                      <input
                        value={r.particulars}
                        onChange={(e) => set(i, { particulars: e.target.value })}
                        className={`${cellInput} min-w-40`}
                      />
                    </td>
                    <td className="px-1 py-1">
                      <input
                        value={r.ref_no}
                        onChange={(e) => set(i, { ref_no: e.target.value })}
                        className={`${cellInput} w-16`}
                      />
                    </td>
                    {showParty && (
                      <td className="max-w-36 truncate px-2 py-1.5 text-[12.5px] text-ink-2">
                        {partyLabel(r)}
                      </td>
                    )}
                    <td className="px-1 py-1">
                      <input
                        inputMode="decimal"
                        value={r.debit}
                        onChange={(e) => set(i, { debit: e.target.value })}
                        className={`${cellInput} w-24 text-right`}
                      />
                    </td>
                    <td className="px-1 py-1">
                      <input
                        inputMode="decimal"
                        value={r.credit}
                        onChange={(e) => set(i, { credit: e.target.value })}
                        className={`${cellInput} w-24 text-right`}
                      />
                    </td>
                    <td className="px-1 py-1">
                      <select
                        value={r.entry_type}
                        onChange={(e) => set(i, { entry_type: e.target.value as EntryType })}
                        className={`${cellInput} w-28`}
                      >
                        {ENTRY_TYPES.map((t) => (
                          <option key={t} value={t}>
                            {t.replace("_", " ")}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="px-1 py-1">
                      <select
                        value={r.gst_rate}
                        onChange={(e) => set(i, { gst_rate: e.target.value })}
                        className={`${cellInput} w-16`}
                      >
                        {RATES.map((rate) => (
                          <option key={rate} value={rate}>
                            {rate === "" ? "—" : `${rate}%`}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="px-1 py-1">
                      <select
                        value={r.bank_account_id}
                        onChange={(e) =>
                          set(i, { bank_account_id: Number(e.target.value) })
                        }
                        className={`${cellInput} w-28`}
                      >
                        {bankAccounts.map((ba) => (
                          <option key={ba.id} value={ba.id}>
                            {ba.name}
                          </option>
                        ))}
                      </select>
                    </td>
                  </>
                )}
                <td className="px-2 py-1.5">
                  <ConfidenceBadge confidence={r.confidence} />
                </td>
                <td className="px-3 py-1.5 text-center">
                  <input
                    type="checkbox"
                    checked={r.include}
                    disabled={readOnly}
                    onChange={(e) => {
                      set(i, { include: e.target.checked });
                      if (!e.target.checked) clearDateFlag(i);
                    }}
                    className="size-4 accent-[#3987e5]"
                  />
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-hairline text-[12.5px] font-medium">
              <td className="px-3 py-3 text-ink-3" colSpan={showParty ? 5 : 4}>
                Included totals
              </td>
              <td className="px-2 py-3 text-right">{inr(totals.dr)}</td>
              <td className="px-2 py-3 text-right">{inr(totals.cr)}</td>
              <td colSpan={5} />
            </tr>
          </tfoot>
        </table>
      </div>

      {!readOnly && (
        <div className="flex items-center justify-between gap-3 border-t border-hairline px-4 py-3">
          <p
            className={`min-h-5 text-[12.5px] ${
              missingDatesText
                ? "text-critical"
                : notice
                  ? notice.tone === "good"
                    ? "text-good"
                    : "text-critical"
                  : "text-ink-3"
            }`}
          >
            {missingDatesText ??
              notice?.text ??
              "Uncheck rows you don't want in the books. Balance rows are excluded for you."}
          </p>
          <div className="flex shrink-0 gap-2">
            <button
              type="button"
              onClick={onSave}
              disabled={pending}
              className="rounded-lg border border-hairline bg-surface-2 px-4 py-2 text-[13px] font-medium text-ink-2 transition-colors hover:text-ink disabled:opacity-40"
            >
              {pending ? "Working…" : "Save draft"}
            </button>
            <button
              type="button"
              onClick={onPost}
              disabled={pending}
              className="rounded-lg bg-accent px-4 py-2 text-[13px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40"
            >
              Save &amp; post
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
