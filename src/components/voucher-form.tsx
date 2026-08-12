"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { createVoucher, createVoucherParty } from "@/lib/actions";
import { inr } from "@/lib/format";
import type { VoucherNavKind } from "@/lib/keymap";
import type { BankAccountKind } from "@/lib/types";
import {
  FOCUS_DATE_EVENT,
  INLINE_CREATE_EVENT,
  SUBMIT_VOUCHER_EVENT,
} from "./shortcuts";

interface PartyOption {
  id: number;
  name: string;
  kind: "customer" | "supplier";
}
interface AccountOption {
  code: string;
  name: string;
}
interface BankAccountOption {
  id: number;
  name: string;
  kind: BankAccountKind;
  account_code: string;
}

const KIND_TABS: { kind: VoucherNavKind; label: string; fkey: string }[] = [
  { kind: "contra", label: "Contra", fkey: "F4" },
  { kind: "payment", label: "Payment", fkey: "F5" },
  { kind: "receipt", label: "Receipt", fkey: "F6" },
  { kind: "journal", label: "Journal", fkey: "F7" },
  { kind: "sale", label: "Sale", fkey: "F8" },
  { kind: "purchase", label: "Purchase", fkey: "F9" },
  { kind: "credit_note", label: "Cr note", fkey: "⌃F8" },
  { kind: "debit_note", label: "Dr note", fkey: "⌃F9" },
];

const CUSTOMER_KINDS = new Set(["sale", "receipt", "credit_note"]);
const GST_KINDS = new Set(["sale", "purchase", "credit_note", "debit_note"]);
const SETTLE_KINDS = new Set(["receipt", "payment"]);

const field =
  "w-full rounded-lg border border-hairline bg-surface-2 px-3 py-2 text-[13px] text-ink outline-none focus:border-accent";
const label =
  "mb-1 block text-[11px] font-semibold uppercase tracking-[0.07em] text-ink-3";

/** UI rupee string → integer paise, mirroring the review grid's convention. */
function rupeesToPaise(s: string): number | null {
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) return null;
  const paise = Math.round(n * 100);
  return paise > 0 ? paise : null;
}

interface LegDraft {
  account_code: string;
  debit: string;
  credit: string;
}

export function VoucherForm({
  kind,
  parties: initialParties,
  accounts,
  canPost,
  bankAccounts,
  today,
  defaultGstRate,
  postedId,
}: {
  kind: VoucherNavKind;
  parties: PartyOption[];
  accounts: AccountOption[];
  /**
   * Whether this user may post (RVOS-006 P0b). Every voucher on this screen
   * writes an immutable journal, so unlike the review grid there is no
   * reversible half to leave enabled — a clerk gets an explanation instead of a
   * form. Presentation only: `createVoucher` independently requires
   * `entry.post`.
   */
  canPost: boolean;
  /** The book's active cash/bank/wallet accounts (RVOS-006 P0a). A contra can
   * now move money bank→bank, not just cash↔bank, so both ends of a contra and
   * every settlement pick from this list. */
  bankAccounts: BankAccountOption[];
  today: string;
  defaultGstRate: number;
  postedId: number | null;
}) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const dateRef = useRef<HTMLInputElement>(null);
  const [parties, setParties] = useState(initialParties);
  const [partyId, setPartyId] = useState<string>("");
  const [amount, setAmount] = useState("");
  const [legs, setLegs] = useState<LegDraft[]>([
    { account_code: "5900", debit: "", credit: "" },
    { account_code: "1100", debit: "", credit: "" },
  ]);
  const [inlineParty, setInlineParty] = useState(false);
  const [inlineName, setInlineName] = useState("");

  // Rendered once and reused by all three selects — the same account list.
  const bankAccountOptions = bankAccounts.map((ba) => (
    <option key={ba.id} value={ba.id}>
      {ba.account_code} {ba.name}
    </option>
  ));
  // A contra defaults to the most common real movement (cash → bank), and a
  // settlement to cash; `?? bankAccounts[0]` keeps a book with no cash account
  // (or no bank account) rendering rather than selecting nothing.
  const cashFirstId = String(
    (bankAccounts.find((ba) => ba.kind === "cash") ?? bankAccounts[0])?.id ?? ""
  );
  const bankFirstId = String(
    (bankAccounts.find((ba) => ba.kind === "bank") ?? bankAccounts[0])?.id ?? ""
  );

  const partyKind = CUSTOMER_KINDS.has(kind) ? "customer" : "supplier";
  const partyOptions = parties.filter((p) => p.kind === partyKind);
  const amountPaise = rupeesToPaise(amount);

  const legTotals = useMemo(() => {
    let dr = 0;
    let cr = 0;
    for (const l of legs) {
      dr += rupeesToPaise(l.debit) ?? 0;
      cr += rupeesToPaise(l.credit) ?? 0;
    }
    return { dr, cr };
  }, [legs]);
  const balanced = legTotals.dr === legTotals.cr && legTotals.dr > 0;

  const legsJson = useMemo(
    () =>
      JSON.stringify(
        legs
          .filter((l) => rupeesToPaise(l.debit) ?? rupeesToPaise(l.credit))
          .map((l) => ({
            account_code: l.account_code,
            party_id: null,
            debit_paise: rupeesToPaise(l.debit) ?? 0,
            credit_paise: rupeesToPaise(l.credit) ?? 0,
          }))
      ),
    [legs]
  );

  // Tally key layer → this form.
  useEffect(() => {
    const submit = () => formRef.current?.requestSubmit();
    const focusDate = () => {
      dateRef.current?.focus();
      dateRef.current?.select?.();
    };
    const inlineCreate = () => setInlineParty(true);
    window.addEventListener(SUBMIT_VOUCHER_EVENT, submit);
    window.addEventListener(FOCUS_DATE_EVENT, focusDate);
    window.addEventListener(INLINE_CREATE_EVENT, inlineCreate);
    return () => {
      window.removeEventListener(SUBMIT_VOUCHER_EVENT, submit);
      window.removeEventListener(FOCUS_DATE_EVENT, focusDate);
      window.removeEventListener(INLINE_CREATE_EVENT, inlineCreate);
    };
  }, []);

  const setLeg = (i: number, patch: Partial<LegDraft>) =>
    setLegs((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  async function addInlineParty() {
    if (!inlineName.trim()) return;
    const created = await createVoucherParty(inlineName, partyKind);
    setParties((ps) => [...ps, { ...created, kind: partyKind }]);
    setPartyId(String(created.id));
    setInlineParty(false);
    setInlineName("");
  }

  return (
    <div>
      {/* Kind switch — segmented, with the Tally key on each segment. */}
      <div className="inline-flex flex-wrap gap-0.5 rounded-lg bg-surface-2 p-0.5">
        {KIND_TABS.map((t) => (
          <button
            key={t.kind}
            type="button"
            onClick={() => router.push(`/vouchers?kind=${t.kind}`)}
            className={`rounded-[7px] px-3 py-1.5 text-[12.5px] font-medium transition-colors ${
              kind === t.kind
                ? "bg-surface text-ink shadow-[0_1px_2px_rgba(0,0,0,0.08)]"
                : "text-ink-2 hover:text-ink"
            }`}
          >
            {t.label}{" "}
            <span className="ml-1 text-[10.5px] font-semibold text-ink-3">
              {t.fkey}
            </span>
          </button>
        ))}
      </div>

      {postedId !== null && (
        <p className="mt-4 flex items-center gap-2 rounded-lg border border-hairline bg-surface px-4 py-2.5 text-[13px] text-ink-2">
          <span className="size-1.5 rounded-full bg-good" />
          Voucher posted as journal #{postedId}.
        </p>
      )}

      <form
        ref={formRef}
        action={createVoucher}
        className="mt-5 max-w-2xl rounded-xl border border-hairline bg-surface p-5"
      >
        <input type="hidden" name="kind" value={kind} />

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className={label} htmlFor="v-date">
              Date <span className="normal-case text-ink-3">(F2)</span>
            </label>
            <input
              ref={dateRef}
              id="v-date"
              type="date"
              name="entry_date"
              defaultValue={today}
              required
              className={field}
            />
          </div>
          <div>
            <label className={label} htmlFor="v-ref">
              Reference no.
            </label>
            <input id="v-ref" name="ref_no" className={field} placeholder="Bill / doc no." />
          </div>
        </div>

        {kind === "contra" && (
          <div className="mt-4 grid grid-cols-3 gap-4">
            <div>
              <label className={label} htmlFor="v-from">From</label>
              <select
                id="v-from"
                name="from_bank_account_id"
                className={field}
                defaultValue={cashFirstId}
              >
                {bankAccountOptions}
              </select>
            </div>
            <div>
              <label className={label} htmlFor="v-to">To</label>
              <select
                id="v-to"
                name="to_bank_account_id"
                className={field}
                defaultValue={bankFirstId}
              >
                {bankAccountOptions}
              </select>
            </div>
            <div>
              <label className={label} htmlFor="v-amt">Amount ₹</label>
              <input
                id="v-amt"
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className={field}
                placeholder="0.00"
              />
            </div>
          </div>
        )}

        {kind !== "contra" && kind !== "journal" && (
          <>
            <div className="mt-4 grid grid-cols-2 gap-4">
              <div>
                <label className={label} htmlFor="v-party">
                  {partyKind === "customer" ? "Customer" : "Supplier"}{" "}
                  <span className="normal-case text-ink-3">(⌥C new)</span>
                </label>
                <select
                  id="v-party"
                  name="party_id"
                  required
                  value={partyId}
                  onChange={(e) => setPartyId(e.target.value)}
                  className={field}
                >
                  <option value="" disabled>
                    Select…
                  </option>
                  {partyOptions.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className={label} htmlFor="v-amt2">
                  Amount ₹ <span className="normal-case text-ink-3">(gross)</span>
                </label>
                <input
                  id="v-amt2"
                  inputMode="decimal"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  className={field}
                  placeholder="0.00"
                />
              </div>
            </div>
            <div className="mt-4 grid grid-cols-2 gap-4">
              {GST_KINDS.has(kind) && (
                <div>
                  <label className={label} htmlFor="v-gst">GST rate</label>
                  <select
                    id="v-gst"
                    name="gst_rate"
                    className={field}
                    defaultValue={String(defaultGstRate)}
                  >
                    {[0, 5, 12, 18, 28].map((r) => (
                      <option key={r} value={r}>
                        {r}%
                      </option>
                    ))}
                  </select>
                </div>
              )}
              {SETTLE_KINDS.has(kind) && (
                <div>
                  <label className={label} htmlFor="v-settle">Settled via</label>
                  <select
                    id="v-settle"
                    name="bank_account_id"
                    className={field}
                    defaultValue={cashFirstId}
                  >
                    {bankAccountOptions}
                  </select>
                </div>
              )}
            </div>
            {inlineParty && (
              <div className="mt-4 flex items-end gap-3 rounded-lg border border-accent/40 bg-accent-soft/40 p-3">
                <div className="flex-1">
                  <label className={label} htmlFor="v-newparty">
                    New {partyKind}
                  </label>
                  <input
                    id="v-newparty"
                    value={inlineName}
                    onChange={(e) => setInlineName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void addInlineParty();
                      }
                    }}
                    className={field}
                    placeholder="Party name"
                    autoFocus
                  />
                </div>
                <button
                  type="button"
                  onClick={() => void addInlineParty()}
                  className="rounded-lg bg-accent px-3 py-2 text-[12.5px] font-semibold text-white hover:brightness-110 active:scale-[.98]"
                >
                  Create
                </button>
                <button
                  type="button"
                  onClick={() => setInlineParty(false)}
                  className="rounded-lg border border-hairline bg-surface-2 px-3 py-2 text-[12.5px] font-medium text-ink-2"
                >
                  Cancel
                </button>
              </div>
            )}
          </>
        )}

        {kind === "journal" && (
          <div className="mt-4">
            <div className="grid grid-cols-[1fr_120px_120px_32px] gap-2 px-1 text-[11px] font-semibold uppercase tracking-[0.07em] text-ink-3">
              <span>Account</span>
              <span className="text-right">Debit ₹</span>
              <span className="text-right">Credit ₹</span>
              <span />
            </div>
            {legs.map((l, i) => (
              <div
                key={i}
                className="mt-2 grid grid-cols-[1fr_120px_120px_32px] items-center gap-2"
              >
                <select
                  aria-label={`Leg ${i + 1} account`}
                  value={l.account_code}
                  onChange={(e) => setLeg(i, { account_code: e.target.value })}
                  className={field}
                >
                  {accounts.map((a) => (
                    <option key={a.code} value={a.code}>
                      {a.code} {a.name}
                    </option>
                  ))}
                </select>
                <input
                  aria-label={`Leg ${i + 1} debit`}
                  inputMode="decimal"
                  value={l.debit}
                  onChange={(e) => setLeg(i, { debit: e.target.value, credit: "" })}
                  className={`${field} text-right`}
                  placeholder="—"
                />
                <input
                  aria-label={`Leg ${i + 1} credit`}
                  inputMode="decimal"
                  value={l.credit}
                  onChange={(e) => setLeg(i, { credit: e.target.value, debit: "" })}
                  className={`${field} text-right`}
                  placeholder="—"
                />
                <button
                  type="button"
                  aria-label={`Remove leg ${i + 1}`}
                  onClick={() => setLegs((ls) => ls.filter((_, j) => j !== i))}
                  disabled={legs.length <= 2}
                  className="grid size-8 place-items-center rounded-lg text-ink-3 hover:bg-surface-2 hover:text-critical disabled:opacity-30"
                >
                  ×
                </button>
              </div>
            ))}
            <div className="mt-3 flex items-center justify-between">
              <button
                type="button"
                onClick={() =>
                  setLegs((ls) => [...ls, { account_code: "5900", debit: "", credit: "" }])
                }
                className="rounded-lg border border-hairline bg-surface-2 px-3 py-1.5 text-[12.5px] font-medium text-ink-2 hover:text-ink"
              >
                + Add leg
              </button>
              <p
                className={`text-[12.5px] font-medium tabular-nums ${
                  balanced ? "text-good" : "text-critical"
                }`}
              >
                Dr {inr(legTotals.dr)} · Cr {inr(legTotals.cr)}
                {balanced ? " — balanced" : " — out of balance"}
              </p>
            </div>
            <input type="hidden" name="legs" value={legsJson} />
          </div>
        )}

        <div className="mt-4">
          <label className={label} htmlFor="v-memo">Narration</label>
          <input id="v-memo" name="memo" className={field} placeholder="What is this entry?" />
        </div>

        {kind !== "journal" && (
          <input type="hidden" name="amount_paise" value={amountPaise ?? ""} />
        )}

        <div className="mt-5 flex items-center gap-3">
          <button
            type="submit"
            disabled={
              !canPost || (kind === "journal" ? !balanced : amountPaise === null)
            }
            className="rounded-lg bg-accent px-4 py-2 text-[12.5px] font-semibold text-white transition hover:brightness-110 active:scale-[.98] disabled:opacity-40"
          >
            Post voucher <span className="ml-1 text-white/70">⌃A</span>
          </button>
          <span className="text-[12px] text-ink-3">
            {canPost
              ? "Posts one immutable journal — corrections are fix-forward."
              : "Your role cannot post to the books — an accountant does this."}
          </span>
        </div>
      </form>
    </div>
  );
}
