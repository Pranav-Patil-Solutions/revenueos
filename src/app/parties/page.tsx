import Link from "next/link";
import { getDb } from "@/lib/db";
import { createParty } from "@/lib/actions";
import { formatDate } from "@/lib/format";
import type { PartyRow } from "@/lib/types";

const field =
  "w-full rounded-lg border border-hairline bg-surface-2 px-3 py-2 text-[13.5px] text-ink outline-none placeholder:text-ink-3 focus:border-accent";
const label = "mb-1.5 block text-[12.5px] font-medium text-ink-3";

export const dynamic = "force-dynamic";

function KindPill({ kind }: { kind: string }) {
  const customer = kind === "customer";
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-hairline bg-surface-2 px-2.5 py-0.5 text-[11.5px] font-medium text-ink-2">
      <span className={`size-1.5 rounded-full ${customer ? "bg-accent" : "bg-warning"}`} />
      {customer ? "Customer" : "Supplier"}
    </span>
  );
}

export default function PartiesPage() {
  const parties = getDb()
    .prepare("SELECT * FROM parties ORDER BY name COLLATE NOCASE")
    .all() as PartyRow[];

  return (
    <div>
      <h1 className="text-[22px] font-semibold tracking-tight">Parties</h1>
      <p className="mt-1 text-[13.5px] text-ink-3">
        Customers and suppliers whose ledgers you keep.
      </p>

      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_320px]">
        <div>
          {parties.length === 0 ? (
            <div className="rounded-xl border border-hairline bg-surface px-6 py-14 text-center">
              <p className="text-[13.5px] font-medium text-ink-2">No parties yet</p>
              <p className="mt-1 text-[12.5px] text-ink-3">
                Add a customer or supplier to start capturing their ledger pages.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-hairline bg-surface">
              <table className="w-full text-left text-[13px]">
                <thead>
                  <tr className="border-b border-hairline text-[11.5px] uppercase tracking-wide text-ink-3">
                    <th className="px-5 py-3 font-medium">Name</th>
                    <th className="px-5 py-3 font-medium">Kind</th>
                    <th className="px-5 py-3 font-medium">GSTIN</th>
                    <th className="px-5 py-3 font-medium">State</th>
                    <th className="px-5 py-3 text-right font-medium">Added</th>
                  </tr>
                </thead>
                <tbody style={{ fontVariantNumeric: "tabular-nums" }}>
                  {parties.map((p) => (
                    <tr
                      key={p.id}
                      className="border-b border-hairline/60 last:border-0 hover:bg-surface-2/50"
                    >
                      <td className="px-5 py-3.5">
                        <Link
                          href={`/parties/${p.id}`}
                          className="font-medium text-ink hover:text-accent"
                        >
                          {p.name}
                        </Link>
                      </td>
                      <td className="px-5 py-3.5">
                        <KindPill kind={p.kind} />
                      </td>
                      <td className="px-5 py-3.5 text-ink-2">{p.gstin || "—"}</td>
                      <td className="px-5 py-3.5 text-ink-2">{p.state_code || "—"}</td>
                      <td className="px-5 py-3.5 text-right text-ink-3">
                        {formatDate(p.created_at)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <form
          action={createParty}
          className="h-fit rounded-xl border border-hairline bg-surface p-5"
        >
          <p className="text-[13.5px] font-semibold">Add a party</p>
          <div className="mt-4 flex flex-col gap-3.5">
            <div>
              <label className={label} htmlFor="name">Name</label>
              <input id="name" name="name" placeholder="Sharma Traders" className={field} required />
            </div>
            <div>
              <label className={label} htmlFor="kind">Kind</label>
              <select id="kind" name="kind" defaultValue="customer" className={field}>
                <option value="customer">Customer</option>
                <option value="supplier">Supplier</option>
              </select>
            </div>
            <div>
              <label className={label} htmlFor="gstin">GSTIN (optional)</label>
              <input id="gstin" name="gstin" className={field} />
            </div>
            <div>
              <label className={label} htmlFor="state_code">State code (optional)</label>
              <input id="state_code" name="state_code" maxLength={2} placeholder="27" className={field} />
            </div>
            <div>
              <label className={label} htmlFor="phone">Phone (optional)</label>
              <input id="phone" name="phone" className={field} />
            </div>
          </div>
          <button
            type="submit"
            className="mt-4 w-full rounded-lg bg-accent px-4 py-2 text-[13px] font-medium text-white transition-opacity hover:opacity-90"
          >
            Add party
          </button>
        </form>
      </div>
    </div>
  );
}
