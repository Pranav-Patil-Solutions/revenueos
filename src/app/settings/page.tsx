import { getDb } from "@/lib/db";
import { updateSettings } from "@/lib/actions";
import { GST_RATES } from "@/lib/tax/india-gst";
import type { SettingsRow } from "@/lib/types";

const field =
  "w-full rounded-lg border border-hairline bg-surface-2 px-3 py-2 text-[13.5px] text-ink outline-none placeholder:text-ink-3 focus:border-accent";
const label = "mb-1.5 block text-[12.5px] font-medium text-ink-3";

export const dynamic = "force-dynamic";

export default function SettingsPage() {
  const s = getDb()
    .prepare("SELECT * FROM settings WHERE id = 1")
    .get() as SettingsRow;

  return (
    <div>
      <h1 className="text-[22px] font-semibold tracking-tight">Settings</h1>
      <p className="mt-1 text-[13.5px] text-ink-3">
        Company profile, GSTIN, and tax defaults.
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
            <label className={label} htmlFor="gstin">GSTIN</label>
            <input id="gstin" name="gstin" defaultValue={s.gstin} placeholder="27ABCDE1234F1Z5" className={field} />
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
          <label className="col-span-2 flex items-center gap-2.5 text-[13.5px] text-ink-2">
            <input
              type="checkbox"
              name="tax_inclusive"
              defaultChecked={s.tax_inclusive === 1}
              className="size-4 accent-[#3987e5]"
            />
            Ledger amounts are tax-inclusive (GST is peeled out of the gross)
          </label>
        </div>
        <div className="mt-5 flex justify-end">
          <button
            type="submit"
            className="rounded-lg bg-accent px-4 py-2 text-[13px] font-medium text-white transition-opacity hover:opacity-90"
          >
            Save settings
          </button>
        </div>
      </form>

      <p className="mt-4 max-w-2xl text-[12px] leading-relaxed text-ink-3">
        Country and currency are carried on every report; tax logic itself is a
        pluggable regime module. India GST is the only tax pack in v1.
      </p>
    </div>
  );
}
