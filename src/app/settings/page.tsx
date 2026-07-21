import Link from "next/link";
import { getDb } from "@/lib/db";
import { updateSettings } from "@/lib/actions";
import { GST_RATES } from "@/lib/tax/india-gst";
import type { SettingsRow } from "@/lib/types";
import { requireSession } from "@/lib/dal";

const field =
  "w-full rounded-lg border border-hairline bg-surface-2 px-3 py-2 text-[13.5px] text-ink outline-none placeholder:text-ink-3 focus:border-accent";
const label = "mb-1.5 block text-[12.5px] font-medium text-ink-3";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  await requireSession();

  const s = getDb()
    .prepare("SELECT * FROM settings WHERE id = 1")
    .get() as SettingsRow;

  return (
    <div>
      <h1 className="text-[22px] font-semibold tracking-tight">Settings</h1>
      <p className="mt-1 text-[13.5px] text-ink-3">
        Company profile, tax identity, and books policy.
      </p>

      <form
        action={updateSettings}
        className="mt-6 max-w-2xl rounded-xl border border-hairline bg-surface p-5"
      >
        <div className="grid grid-cols-2 gap-4">
          <div className="col-span-2">
            <label className={label} htmlFor="company_name">Company name</label>
            <input id="company_name" name="company_name" defaultValue={s.company_name} className={field} required />
          </div>
          <div>
            <label className={label} htmlFor="entity_type">Entity type</label>
            <select id="entity_type" name="entity_type" defaultValue={s.entity_type} className={field}>
              <option value="proprietorship">Proprietorship</option>
              <option value="partnership">Partnership / LLP</option>
              <option value="company">Private limited company</option>
            </select>
          </div>
          <div>
            <label className={label} htmlFor="gstin">GSTIN</label>
            <input id="gstin" name="gstin" defaultValue={s.gstin} placeholder="27ABCDE1234F1Z5" className={field} />
          </div>
          <div>
            <label className={label} htmlFor="pan">PAN</label>
            <input id="pan" name="pan" defaultValue={s.pan} placeholder="ABCDE1234F" maxLength={10} className={field} />
          </div>
          <div>
            <label className={label} htmlFor="tan">TAN</label>
            <input id="tan" name="tan" defaultValue={s.tan} placeholder="MUMA12345B" maxLength={10} className={field} />
          </div>
          <div>
            <label className={label} htmlFor="it_regime">Income-tax regime</label>
            <select id="it_regime" name="it_regime" defaultValue={s.it_regime} className={field}>
              <option value="new">New regime (115BAC)</option>
              <option value="old">Old regime</option>
            </select>
          </div>
          <div>
            <label className={label} htmlFor="presumptive">Presumptive scheme</label>
            <select id="presumptive" name="presumptive" defaultValue={s.presumptive} className={field}>
              <option value="">None — regular books</option>
              <option value="44AD">44AD — presumptive business</option>
              <option value="44ADA">44ADA — presumptive profession</option>
            </select>
          </div>
          <div>
            <label className={label} htmlFor="state_code">State code</label>
            <input id="state_code" name="state_code" defaultValue={s.state_code} maxLength={2} placeholder="27" className={field} />
          </div>
          <div>
            <label className={label} htmlFor="country">Country</label>
            <input id="country" name="country" defaultValue={s.country} maxLength={2} className={field} />
          </div>
          <div>
            <label className={label} htmlFor="currency">Currency</label>
            <input id="currency" name="currency" defaultValue={s.currency} maxLength={3} className={field} />
          </div>
          <div>
            <label className={label} htmlFor="default_gst_rate">Default GST rate</label>
            <select id="default_gst_rate" name="default_gst_rate" defaultValue={s.default_gst_rate} className={field}>
              {GST_RATES.map((r) => (
                <option key={r} value={r}>{r}%</option>
              ))}
            </select>
          </div>
          <div>
            <label className={label} htmlFor="books_locked_through">Books locked through</label>
            <input
              id="books_locked_through"
              name="books_locked_through"
              type="date"
              defaultValue={s.books_locked_through}
              className={field}
            />
            <p className="mt-1 text-[11.5px] text-ink-3">
              Blocks posting on or before this date. Leave blank to keep books open.
            </p>
          </div>
          <label className="col-span-2 flex items-center gap-2.5 text-[13.5px] text-ink-2">
            <input
              type="checkbox"
              name="tax_inclusive"
              defaultChecked={s.tax_inclusive === 1}
              className="size-4 accent-[#007aff]"
            />
            Ledger amounts are tax-inclusive (GST is peeled out of the gross)
          </label>
          <label className="col-span-2 flex items-center gap-2.5 text-[13.5px] text-ink-2">
            <input
              type="checkbox"
              name="fy_audit_case"
              defaultChecked={s.fy_audit_case === 1}
              className="size-4 accent-[#007aff]"
            />
            Tax-audit case (moves the ITR due date to 31 October)
          </label>
        </div>
        <div className="mt-5 flex justify-end">
          <button type="submit" className="btn">
            Save settings
          </button>
        </div>
      </form>

      <div className="mt-4 max-w-2xl rounded-xl border border-hairline bg-surface p-5">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-[13.5px] font-semibold">Chart of accounts</p>
            <p className="mt-0.5 text-[12.5px] text-ink-3">
              Grouped account list — add ledger heads or rename existing ones.
            </p>
          </div>
          <Link
            href="/settings/accounts"
            className="btn-quiet btn shrink-0"
          >
            Open
          </Link>
        </div>
      </div>

      <p className="mt-4 max-w-2xl text-[12px] leading-relaxed text-ink-3">
        Country and currency are carried on every report; tax logic itself is a
        pluggable regime module. India GST is the only tax pack in v1.
      </p>
    </div>
  );
}
