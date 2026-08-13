import Link from "next/link";
import {
  archiveCostCentreAction,
  createCostCentreAction,
  renameCostCentreAction,
} from "@/lib/actions";
import { costCentreUsage, listCostCentres } from "@/lib/cost-centres";
import { requireBook, userCan } from "@/lib/dal";

const field =
  "w-full rounded-lg border border-hairline bg-surface-2 px-3 py-2 text-[13.5px] text-ink outline-none placeholder:text-ink-3 focus:border-accent";
const label = "mb-1.5 block text-[12.5px] font-medium text-ink-3";

export const dynamic = "force-dynamic";

export default async function CostCentresPage() {
  const { book, user } = await requireBook();
  // Presentation only — every action here independently requires
  // accounts.manage, so a crafted request is refused either way.
  const canManage = userCan(user, "accounts.manage");
  const centres = listCostCentres(book, { includeArchived: true });
  const usage = costCentreUsage(book);

  return (
    <div>
      <div className="flex items-baseline gap-3">
        <h1 className="text-[22px] font-semibold tracking-tight">Cost centres</h1>
        <Link href="/settings" className="text-[12.5px] text-ink-3 hover:text-accent">
          ← Settings
        </Link>
      </div>
      <p className="mt-1 text-[13.5px] text-ink-3">
        The parts of the business a figure can belong to — a shop, a site, a
        division. Tagging entries with one lets the P&amp;L be read per centre
        instead of blended. Optional: an entry with no centre belongs to the
        business as a whole, which is the normal case. Only income and expense
        lines carry one — a bank, GST or party balance belongs to the business,
        not to a part of it.
      </p>

      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_320px]">
        <div className="overflow-x-auto rounded-xl border border-hairline bg-surface">
          {centres.length === 0 ? (
            <p className="px-4 py-10 text-center text-[13px] text-ink-3">
              No cost centres yet. Add one to start attributing income and
              spend; leave this empty and the books work exactly as before.
            </p>
          ) : (
            <table className="w-full text-left text-[13px]">
              <thead>
                <tr className="border-b border-hairline text-[11.5px] uppercase tracking-wide text-ink-3">
                  <th className="w-40 px-3 py-2.5 font-medium">Code</th>
                  <th className="px-3 py-2.5 font-medium">Name</th>
                  <th className="w-24 px-2 py-2.5 font-medium">Lines</th>
                  <th className="w-20 px-3 py-2.5 font-medium" />
                </tr>
              </thead>
              <tbody style={{ fontVariantNumeric: "tabular-nums" }}>
                {centres.map((cc) => (
                  <tr
                    key={cc.id}
                    className={`border-b border-hairline/60 last:border-0 hover:bg-surface-2/50 ${
                      cc.archived_at ? "opacity-50" : ""
                    }`}
                  >
                    <td className="whitespace-nowrap px-3 py-2 font-medium text-ink-2">{cc.code}</td>
                    <td className="px-3 py-2">
                      <form action={renameCostCentreAction} className="flex items-center gap-2">
                        <input type="hidden" name="id" value={cc.id} />
                        {/* min-w-0 flex-1, not w-full — a flex item's default
                            min-width is auto, which collapsed the same input on
                            the bank-accounts page to ~18px. */}
                        <input
                          name="name"
                          defaultValue={cc.name}
                          aria-label={`Rename cost centre ${cc.code}`}
                          className="min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-2 py-1 text-[13px] text-ink outline-none focus:border-hairline focus:bg-surface-2"
                          required
                          disabled={!!cc.archived_at}
                        />
                        {!cc.archived_at && (
                          <button
                            type="submit"
                            disabled={!canManage}
                            className="shrink-0 rounded-md px-2 py-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-3 hover:text-accent"
                          >
                            Save
                          </button>
                        )}
                      </form>
                    </td>
                    {/* The count is why archiving is safe to offer: it says how
                        much history would keep pointing here. */}
                    <td className="px-2 py-2 text-ink-3">{usage.get(cc.id) ?? 0}</td>
                    <td className="px-3 py-2">
                      {cc.archived_at ? (
                        <span className="text-[11px] text-ink-3">Archived</span>
                      ) : (
                        <form action={archiveCostCentreAction}>
                          <input type="hidden" name="id" value={cc.id} />
                          <button
                            type="submit"
                            disabled={!canManage}
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
          )}
        </div>

        <form action={createCostCentreAction} className="card h-fit p-5">
          <p className="text-[13.5px] font-semibold">Add a cost centre</p>
          <div className="mt-4 flex flex-col gap-3.5">
            <div>
              <label className={label} htmlFor="name">Name</label>
              <input
                id="name"
                name="name"
                placeholder="Shop — Kothrud"
                className={field}
                required
              />
            </div>
            <div>
              <label className={label} htmlFor="code">Code</label>
              <input
                id="code"
                name="code"
                placeholder="Optional — derived from the name"
                className={field}
              />
              <p className="mt-1 text-[11.5px] text-ink-3">
                Short and stable: reports and budgets are keyed by it.
              </p>
            </div>
          </div>
          <button type="submit" disabled={!canManage} className="btn mt-4 w-full">
            Add cost centre
          </button>
        </form>
      </div>
    </div>
  );
}
