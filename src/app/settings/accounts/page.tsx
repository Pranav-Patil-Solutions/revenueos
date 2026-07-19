import Link from "next/link";
import { createAccount, renameAccount } from "@/lib/actions";
import { ACCOUNT_GROUPS, DEFAULT_GROUP_BY_TYPE } from "@/lib/coa";
import { getDb } from "@/lib/db";
import type { AccountRow } from "@/lib/types";

const field =
  "w-full rounded-lg border border-hairline bg-surface-2 px-3 py-2 text-[13.5px] text-ink outline-none placeholder:text-ink-3 focus:border-accent";
const label = "mb-1.5 block text-[12.5px] font-medium text-ink-3";

export const dynamic = "force-dynamic";

export default function AccountsPage() {
  const accounts = getDb()
    .prepare("SELECT * FROM accounts ORDER BY code")
    .all() as AccountRow[];

  const byGroup = new Map<string, AccountRow[]>();
  for (const a of accounts) {
    const g = a.group_code ?? DEFAULT_GROUP_BY_TYPE[a.type];
    if (!byGroup.has(g)) byGroup.set(g, []);
    byGroup.get(g)!.push(a);
  }

  return (
    <div>
      <div className="flex items-baseline gap-3">
        <h1 className="text-[22px] font-semibold tracking-tight">
          Chart of accounts
        </h1>
        <Link href="/settings" className="text-[12.5px] text-ink-3 hover:text-accent">
          ← Settings
        </Link>
      </div>
      <p className="mt-1 text-[13.5px] text-ink-3">
        Ledger heads grouped for the statements. Accounts are add-only — rename
        freely, but posted books never lose an account.
      </p>

      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_320px]">
        <div className="flex flex-col gap-6">
          {ACCOUNT_GROUPS.filter((g) => byGroup.has(g.code)).map((group) => (
            <div key={group.code}>
              <p className="microlabel mb-2">{group.label}</p>
              <div className="overflow-x-auto rounded-xl border border-hairline bg-surface">
                <table className="w-full text-left text-[13px]">
                  <thead>
                    <tr className="border-b border-hairline text-[11.5px] uppercase tracking-wide text-ink-3">
                      <th className="w-24 px-5 py-2.5 font-medium">Code</th>
                      <th className="px-5 py-2.5 font-medium">Name</th>
                      <th className="w-28 px-5 py-2.5 font-medium">Type</th>
                      <th className="w-20 px-5 py-2.5 font-medium" />
                    </tr>
                  </thead>
                  <tbody style={{ fontVariantNumeric: "tabular-nums" }}>
                    {byGroup.get(group.code)!.map((a) => (
                      <tr
                        key={a.id}
                        className="border-b border-hairline/60 last:border-0 hover:bg-surface-2/50"
                      >
                        <td className="px-5 py-2 font-medium text-ink-2">
                          {a.code}
                        </td>
                        <td className="px-5 py-2">
                          <form
                            action={renameAccount}
                            className="flex items-center gap-2"
                          >
                            <input type="hidden" name="id" value={a.id} />
                            <input
                              name="name"
                              defaultValue={a.name}
                              aria-label={`Rename account ${a.code}`}
                              className="w-full rounded-md border border-transparent bg-transparent px-2 py-1 text-[13px] text-ink outline-none focus:border-hairline focus:bg-surface-2"
                              required
                            />
                            <button
                              type="submit"
                              className="rounded-md px-2 py-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-3 hover:text-accent"
                            >
                              Save
                            </button>
                          </form>
                        </td>
                        <td className="px-5 py-2 text-ink-3">{a.type}</td>
                        <td className="px-5 py-2" />
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </div>

        <form action={createAccount} className="card h-fit p-5">
          <p className="text-[13.5px] font-semibold">Add an account</p>
          <div className="mt-4 flex flex-col gap-3.5">
            <div>
              <label className={label} htmlFor="code">Code</label>
              <input id="code" name="code" placeholder="5910" maxLength={4} className={field} required />
            </div>
            <div>
              <label className={label} htmlFor="name">Name</label>
              <input id="name" name="name" placeholder="Office rent" className={field} required />
            </div>
            <div>
              <label className={label} htmlFor="type">Type</label>
              <select id="type" name="type" defaultValue="expense" className={field}>
                <option value="asset">Asset</option>
                <option value="liability">Liability</option>
                <option value="equity">Equity</option>
                <option value="income">Income</option>
                <option value="expense">Expense</option>
              </select>
            </div>
            <div>
              <label className={label} htmlFor="group_code">Group</label>
              <select id="group_code" name="group_code" defaultValue="indirect_expenses" className={field}>
                {ACCOUNT_GROUPS.map((g) => (
                  <option key={g.code} value={g.code}>{g.label}</option>
                ))}
              </select>
            </div>
          </div>
          <button type="submit" className="btn mt-4 w-full">
            Add account
          </button>
        </form>
      </div>
    </div>
  );
}
