import {
  archiveCompanyAction,
  createCompanyAction,
  renameCompanyAction,
  switchCompany,
} from "@/lib/actions";
import { listCompanies } from "@/lib/companies";
import { requireSession } from "@/lib/dal";
import { getDb } from "@/lib/db";

const field =
  "w-full rounded-lg border border-hairline bg-surface-2 px-3 py-2 text-[13.5px] text-ink outline-none placeholder:text-ink-3 focus:border-accent";
const label = "mb-1.5 block text-[12.5px] font-medium text-ink-3";

export const dynamic = "force-dynamic";

export default async function CompaniesPage() {
  const user = await requireSession();
  const db = getDb();
  const active = listCompanies(db);
  const archived = listCompanies(db, { includeArchived: true }).filter(
    (c) => c.archived_at !== null
  );

  return (
    <div>
      <h1 className="text-[22px] font-semibold tracking-tight">Companies</h1>
      <p className="mt-1 text-[13.5px] text-ink-3">
        Every client whose books this office keeps. All signed-in staff see
        every company here — per-staff access is not built yet.
      </p>

      {active.length === 0 && (
        <p className="mt-6 max-w-2xl rounded-xl border border-hairline bg-surface p-5 text-[13.5px] text-ink-3">
          No company yet. Create the first one below.
        </p>
      )}

      <div className="mt-6 flex max-w-2xl flex-col gap-3">
        {active.map((c) => {
          const isCurrent = user.companyId === c.id;
          return (
            <div
              key={c.id}
              className="rounded-xl border border-hairline bg-surface p-4"
            >
              <div className="flex items-center justify-between gap-4">
                <div>
                  <p className="text-[13.5px] font-semibold">
                    {c.name}
                    {isCurrent && <span className="pill ml-2">Active</span>}
                  </p>
                  <p className="mt-0.5 text-[12px] text-ink-3">
                    {c.entity_type} · {c.gstin || "no GSTIN"}
                  </p>
                </div>
                {!isCurrent && (
                  <form action={switchCompany}>
                    <input type="hidden" name="company_id" value={c.id} />
                    <button type="submit" className="btn shrink-0">
                      Switch
                    </button>
                  </form>
                )}
              </div>

              <details className="mt-3">
                <summary className="cursor-pointer text-[12px] text-ink-3">
                  Rename or archive
                </summary>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <form
                    action={renameCompanyAction}
                    className="flex items-center gap-2"
                  >
                    <input type="hidden" name="company_id" value={c.id} />
                    <input
                      name="name"
                      defaultValue={c.name}
                      className={`${field} w-48`}
                      required
                    />
                    <button type="submit" className="btn-quiet btn">
                      Rename
                    </button>
                  </form>
                  <form action={archiveCompanyAction}>
                    <input type="hidden" name="company_id" value={c.id} />
                    <button type="submit" className="btn-quiet btn">
                      Archive
                    </button>
                  </form>
                </div>
                <p className="mt-1.5 text-[11.5px] text-ink-3">
                  Archiving hides this company from the switcher. Its books
                  are kept, never deleted — there is no un-archive here yet.
                </p>
              </details>
            </div>
          );
        })}
      </div>

      <div className="mt-6 max-w-2xl rounded-xl border border-hairline bg-surface p-5">
        <p className="text-[13.5px] font-semibold">Add a company</p>
        <form action={createCompanyAction} className="mt-3 grid grid-cols-2 gap-4">
          <div className="col-span-2">
            <label className={label} htmlFor="name">Company name</label>
            <input id="name" name="name" className={field} required />
          </div>
          <div>
            <label className={label} htmlFor="entity_type">Entity type</label>
            <select id="entity_type" name="entity_type" defaultValue="proprietorship" className={field}>
              <option value="proprietorship">Proprietorship</option>
              <option value="partnership">Partnership / LLP</option>
              <option value="company">Private limited company</option>
            </select>
          </div>
          <div>
            <label className={label} htmlFor="state_code">State code</label>
            <input id="state_code" name="state_code" maxLength={2} placeholder="27" className={field} />
          </div>
          <div>
            <label className={label} htmlFor="gstin">GSTIN</label>
            <input id="gstin" name="gstin" placeholder="27ABCDE1234F1Z5" className={field} />
          </div>
          <div>
            <label className={label} htmlFor="pan">PAN</label>
            <input id="pan" name="pan" placeholder="ABCDE1234F" maxLength={10} className={field} />
          </div>
          <div className="col-span-2">
            <label className={label} htmlFor="tan">TAN</label>
            <input id="tan" name="tan" placeholder="MUMA12345B" maxLength={10} className={field} />
          </div>
          <div className="col-span-2 flex justify-end">
            <button type="submit" className="btn">
              Create company
            </button>
          </div>
        </form>
        <p className="mt-3 text-[11.5px] text-ink-3">
          A new company gets its own chart of accounts automatically. It
          starts with no opening balances — switch to it and post those
          first (Vouchers → Journal), before anything else.
        </p>
      </div>

      {archived.length > 0 && (
        <div className="mt-6 max-w-2xl">
          <p className="text-[12.5px] font-medium text-ink-3">
            Archived ({archived.length})
          </p>
          <div className="mt-2 flex flex-col gap-2">
            {archived.map((c) => (
              <div
                key={c.id}
                className="rounded-xl border border-hairline bg-surface-2 p-3 text-[12.5px] text-ink-3"
              >
                {c.name}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
