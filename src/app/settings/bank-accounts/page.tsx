import Link from "next/link";
import {
  archiveBankAccountAction,
  createBankAccountAction,
  renameBankAccountAction,
  setDefaultBankAccountAction,
} from "@/lib/actions";
import { listBankAccounts } from "@/lib/bank-accounts";
import type { BankAccountKind } from "@/lib/types";
import { requireBook } from "@/lib/dal";

const field =
  "w-full rounded-lg border border-hairline bg-surface-2 px-3 py-2 text-[13.5px] text-ink outline-none placeholder:text-ink-3 focus:border-accent";
const label = "mb-1.5 block text-[12.5px] font-medium text-ink-3";

const KIND_LABEL: Record<BankAccountKind, string> = {
  bank: "Bank",
  cash: "Cash",
  wallet: "Wallet",
  card: "Card",
};

export const dynamic = "force-dynamic";

export default async function BankAccountsPage() {
  const { book } = await requireBook();
  const accounts = listBankAccounts(book, { includeArchived: true });

  return (
    <div>
      <div className="flex items-baseline gap-3">
        <h1 className="text-[22px] font-semibold tracking-tight">
          Bank &amp; cash accounts
        </h1>
        <Link href="/settings" className="text-[12.5px] text-ink-3 hover:text-accent">
          ← Settings
        </Link>
      </div>
      <p className="mt-1 text-[13.5px] text-ink-3">
        Every current account, cash drawer, wallet and card the business
        actually holds. Each gets its own ledger, so the balance sheet and
        bank reconciliation can tell them apart — vouchers and imports settle
        against one of these, never a bare &quot;cash&quot; or
        &quot;bank&quot; label.
      </p>

      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_320px]">
        <div className="overflow-x-auto rounded-xl border border-hairline bg-surface">
          <table className="w-full text-left text-[13px]">
            <thead>
              <tr className="border-b border-hairline text-[11.5px] uppercase tracking-wide text-ink-3">
                <th className="w-16 px-3 py-2.5 font-medium">Ledger</th>
                <th className="px-3 py-2.5 font-medium">Name</th>
                <th className="w-16 px-2 py-2.5 font-medium">Kind</th>
                <th className="w-24 px-2 py-2.5 font-medium">Acct no.</th>
                <th className="w-20 px-2 py-2.5 font-medium" />
                <th className="w-20 px-3 py-2.5 font-medium" />
              </tr>
            </thead>
            <tbody style={{ fontVariantNumeric: "tabular-nums" }}>
              {accounts.map((a) => (
                <tr
                  key={a.id}
                  className={`border-b border-hairline/60 last:border-0 hover:bg-surface-2/50 ${
                    a.archived_at ? "opacity-50" : ""
                  }`}
                >
                  <td className="px-3 py-2 font-medium text-ink-2">
                    {a.account_code}
                  </td>
                  <td className="px-3 py-2">
                    <form action={renameBankAccountAction} className="flex items-center gap-2">
                      <input type="hidden" name="id" value={a.id} />
                      {/* min-w-0 flex-1, not w-full: a flex item's default
                          min-width is auto, so `w-full` let the Save button
                          win the row and squeezed this input to ~18px — the
                          name was present but unreadable and un-editable. */}
                      <input
                        name="name"
                        defaultValue={a.name}
                        aria-label={`Rename account ${a.account_code}`}
                        className="min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-2 py-1 text-[13px] text-ink outline-none focus:border-hairline focus:bg-surface-2"
                        required
                        disabled={!!a.archived_at}
                      />
                      {!a.archived_at && (
                        <button
                          type="submit"
                          className="shrink-0 rounded-md px-2 py-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-3 hover:text-accent"
                        >
                          Save
                        </button>
                      )}
                    </form>
                  </td>
                  <td className="px-2 py-2 text-ink-3">{KIND_LABEL[a.kind]}</td>
                  <td className="px-2 py-2 text-ink-3">{a.account_no || "—"}</td>
                  <td className="px-2 py-2">
                    {a.is_default === 1 ? (
                      <span className="rounded-full border border-hairline bg-surface-2 px-2 py-0.5 text-[11px] font-medium text-ink-2">
                        Default
                      </span>
                    ) : (
                      !a.archived_at && (
                        <form action={setDefaultBankAccountAction}>
                          <input type="hidden" name="id" value={a.id} />
                          <button
                            type="submit"
                            className="text-[11px] font-medium text-ink-3 hover:text-accent"
                          >
                            Make default
                          </button>
                        </form>
                      )
                    )}
                  </td>
                  <td className="px-3 py-2">
                    {a.archived_at ? (
                      <span className="text-[11px] text-ink-3">Archived</span>
                    ) : (
                      <form action={archiveBankAccountAction}>
                        <input type="hidden" name="id" value={a.id} />
                        <button
                          type="submit"
                          className="text-[11px] font-medium text-ink-3 hover:text-danger"
                        >
                          Archive
                        </button>
                      </form>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <form action={createBankAccountAction} className="card h-fit p-5">
          <p className="text-[13.5px] font-semibold">Add an account</p>
          <div className="mt-4 flex flex-col gap-3.5">
            <div>
              <label className={label} htmlFor="name">Name</label>
              <input
                id="name"
                name="name"
                placeholder="HDFC Current — 4021"
                className={field}
                required
              />
            </div>
            <div>
              <label className={label} htmlFor="kind">Kind</label>
              <select id="kind" name="kind" defaultValue="bank" className={field}>
                <option value="bank">Bank</option>
                <option value="cash">Cash</option>
                <option value="wallet">Wallet</option>
                <option value="card">Card</option>
              </select>
            </div>
            <div>
              <label className={label} htmlFor="account_no">Account no.</label>
              <input id="account_no" name="account_no" placeholder="Optional" className={field} />
            </div>
            <div>
              <label className={label} htmlFor="ifsc">IFSC</label>
              <input
                id="ifsc"
                name="ifsc"
                placeholder="HDFC0001234 (optional)"
                className={field}
              />
            </div>
            <label className="flex items-center gap-2 text-[12.5px] text-ink-2">
              <input type="checkbox" name="is_default" />
              Make this the default of its kind
            </label>
          </div>
          <button type="submit" className="btn mt-4 w-full">
            Add account
          </button>
        </form>
      </div>
    </div>
  );
}
