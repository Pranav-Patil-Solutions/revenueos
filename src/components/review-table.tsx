"use client";

import { useMemo, useState, useTransition } from "react";
import { saveAndPost, saveDraftRows } from "@/lib/actions";
import { inr } from "@/lib/format";
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
  entry_date: string; // "" = null
  particulars: string;
  ref_no: string;
  debit: string; // rupees as typed
  credit: string;
  entry_type: EntryType;
  gst_rate: string; // "" = null
  settle_account: "cash" | "bank";
  include: boolean;
  confidence: number;
  is_balance_row: boolean;
}

const cellInput =
  "w-full rounded-md border border-transparent bg-transparent px-1.5 py-1 text-[12.5px] text-ink outline-none hover:border-hairline focus:border-accent focus:bg-surface-2";

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
}: {
  docId: number;
  rows: StagedRow[];
  readOnly: boolean;
}) {
  const [edit, setEdit] = useState<EditRow[]>(() =>
    rows.map((r) => ({
      id: r.id,
      row_no: r.row_no,
      entry_date: r.entry_date ?? "",
      particulars: r.particulars,
      ref_no: r.ref_no,
      debit: paiseToInput(r.debit_paise),
      credit: paiseToInput(r.credit_paise),
      entry_type: r.entry_type,
      gst_rate: r.gst_rate === null ? "" : String(r.gst_rate),
      settle_account: r.settle_account,
      include: r.include === 1,
      confidence: r.confidence,
      is_balance_row: r.is_balance_row === 1,
    }))
  );
  const [pending, startTransition] = useTransition();
  const [notice, setNotice] = useState<{ tone: "good" | "bad"; text: string } | null>(null);

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
        settle_account: r.settle_account,
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
      <div className="overflow-x-auto">
        <table className="w-full min-w-[920px] text-left text-[12.5px]">
          <thead>
            <tr className="border-b border-hairline text-[11.5px] uppercase tracking-wide text-ink-3">
              <th className="px-3 py-3 font-medium">#</th>
              <th className="px-2 py-3 font-medium">Date</th>
              <th className="px-2 py-3 font-medium">Particulars</th>
              <th className="px-2 py-3 font-medium">Ref</th>
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
                    <td className="px-2 py-1.5 text-right">{r.debit || ""}</td>
                    <td className="px-2 py-1.5 text-right">{r.credit || ""}</td>
                    <td className="px-2 py-1.5">{r.entry_type.replace("_", " ")}</td>
                    <td className="px-2 py-1.5">{r.gst_rate === "" ? "—" : `${r.gst_rate}%`}</td>
                    <td className="px-2 py-1.5">{r.settle_account}</td>
                  </>
                ) : (
                  <>
                    <td className="px-1 py-1">
                      <input
                        type="date"
                        value={r.entry_date}
                        onChange={(e) => set(i, { entry_date: e.target.value })}
                        className={`${cellInput} w-32`}
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
                        value={r.settle_account}
                        onChange={(e) =>
                          set(i, { settle_account: e.target.value as "cash" | "bank" })
                        }
                        className={`${cellInput} w-18`}
                      >
                        <option value="cash">cash</option>
                        <option value="bank">bank</option>
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
                    onChange={(e) => set(i, { include: e.target.checked })}
                    className="size-4 accent-[#3987e5]"
                  />
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-hairline text-[12.5px] font-medium">
              <td className="px-3 py-3 text-ink-3" colSpan={4}>
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
              notice ? (notice.tone === "good" ? "text-good" : "text-critical") : "text-ink-3"
            }`}
          >
            {notice?.text ??
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
