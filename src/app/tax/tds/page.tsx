import { ExportLinks } from "@/components/report-tabs";
import { FySelect } from "@/components/fy-select";
import { TaxTabs } from "@/components/tax-tabs";
import { createTdsChallan, createTdsVoucher } from "@/lib/actions";
import { getDb } from "@/lib/db";
import { formatDate, inr, todayIso } from "@/lib/format";
import { currentFy, fyLabel, fyList } from "@/lib/fy";
import { q24Summary, q26Summary, TDS_SECTIONS, tdsRegister } from "@/lib/tax/tds";
import type { PartyRow, TdsChallanRow } from "@/lib/types";

export const dynamic = "force-dynamic";

const field =
  "w-full rounded-lg border border-hairline bg-surface-2 px-3 py-2 text-[13px] text-ink outline-none focus:border-accent";
const cell = "px-4 py-2.5 text-[13px] tabular-nums";

export default async function TdsPage({
  searchParams,
}: {
  searchParams: Promise<{ fy?: string; q?: string }>;
}) {
  const sp = await searchParams;
  const db = getDb();
  const books = fyList(db);
  const fys = books.includes(currentFy()) ? books : [currentFy(), ...books];
  const fy = fys.includes(sp.fy ?? "") ? sp.fy! : fys[0];
  const quarter = ([1, 2, 3, 4] as const).find((n) => String(n) === sp.q) ?? 1;

  const register = tdsRegister(db, fy);
  const q26 = q26Summary(db, fy, quarter);
  const q24 = q24Summary(db, fy, quarter);
  const challans = db
    .prepare("SELECT * FROM tds_challans WHERE fy = ? ORDER BY paid_on DESC, id DESC")
    .all(fy) as TdsChallanRow[];
  const parties = db
    .prepare("SELECT * FROM parties ORDER BY name COLLATE NOCASE")
    .all() as PartyRow[];
  const undepositedAll = register
    .filter((r) => r.challan_id === null)
    .reduce((s, r) => s + r.tds_paise, 0);

  return (
    <div>
      <h1 className="text-[22px] font-semibold tracking-tight">Tax &amp; filing</h1>
      <TaxTabs />

      <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
        <form method="get" className="flex items-center gap-2">
          <FySelect fys={fys} value={fy} />
          <select
            name="q"
            defaultValue={String(quarter)}
            aria-label="Quarter"
            className="rounded-lg border border-hairline bg-surface-2 px-3 py-1.5 text-[13px] text-ink outline-none focus:border-accent"
          >
            {[1, 2, 3, 4].map((n) => (
              <option key={n} value={n}>
                Q{n}
              </option>
            ))}
          </select>
          <button
            type="submit"
            className="rounded-lg border border-hairline bg-surface-2 px-3 py-1.5 text-[12.5px] font-medium text-ink-2 hover:text-ink"
          >
            Apply
          </button>
        </form>
        <span className="flex items-center gap-1.5">
          <ExportLinks base={`/api/export/tds-26q?fy=${fy}&quarter=${quarter}`} />
          <span className="text-[11.5px] text-ink-3">26Q</span>
          <ExportLinks base={`/api/export/tds-24q?fy=${fy}&quarter=${quarter}`} />
          <span className="text-[11.5px] text-ink-3">24Q</span>
        </span>
      </div>

      {TDS_SECTIONS.some((s) => !s.verified) && (
        <p className="mt-4 rounded-lg border border-hairline bg-surface-2/60 px-4 py-2.5 text-[12.5px] text-ink-3">
          Some section rates in this app are unconfirmed against the
          renumbered Act — verify before filing. CA to verify.
        </p>
      )}
      <p className="mt-4 rounded-lg border border-hairline bg-surface-2/60 px-4 py-2.5 text-[12.5px] text-ink-3">
        From FY 2026-27, quarterly statements file on Form 140 (old 26Q) and
        Form 138 (old 24Q) under the Income-tax Rules 2026 — the familiar
        names are kept here as labels.
      </p>

      {/* -------- New deduction -------- */}
      <section className="mt-5 overflow-hidden rounded-xl border border-hairline bg-surface">
        <div className="border-b border-hairline px-5 py-3.5">
          <h2 className="text-[15px] font-semibold tracking-tight">
            Pay a bill net of TDS
          </h2>
          <p className="mt-0.5 text-[12px] text-ink-3">
            One entry: expense at gross, TDS held in 2300, the rest paid out.
            Payees without a PAN deduct at 20%.
          </p>
        </div>
        <form
          action={createTdsVoucher}
          className="grid gap-3 px-5 py-4 sm:grid-cols-2 lg:grid-cols-4"
        >
          <div>
            <label className="mb-1.5 block text-[12px] font-medium text-ink-3" htmlFor="tds-party">
              Payee
            </label>
            <select id="tds-party" name="party_id" required className={field}>
              {parties.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.pan ? "" : " · no PAN (20%)"}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1.5 block text-[12px] font-medium text-ink-3" htmlFor="tds-section">
              Section
            </label>
            <select id="tds-section" name="section" required className={field} defaultValue="194C">
              {TDS_SECTIONS.map((s) => (
                <option key={s.code} value={s.code}>
                  {s.code} · {s.label}
                  {s.bp > 0 ? ` · ${s.bp / 100}%` : ""}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1.5 block text-[12px] font-medium text-ink-3" htmlFor="tds-base">
              Bill ₹ (gross)
            </label>
            <input id="tds-base" name="base" required inputMode="decimal" placeholder="10,000" className={field} />
          </div>
          <div>
            <label className="mb-1.5 block text-[12px] font-medium text-ink-3" htmlFor="tds-date">
              Paid on
            </label>
            <input id="tds-date" name="entry_date" type="date" required defaultValue={todayIso()} className={field} />
          </div>
          <div>
            <label className="mb-1.5 block text-[12px] font-medium text-ink-3" htmlFor="tds-settle">
              Paid from
            </label>
            <select id="tds-settle" name="settle_account" className={field} defaultValue="bank">
              <option value="bank">Bank</option>
              <option value="cash">Cash</option>
            </select>
          </div>
          <div>
            <label className="mb-1.5 block text-[12px] font-medium text-ink-3" htmlFor="tds-override">
              TDS ₹ override
            </label>
            <input id="tds-override" name="tds_override" inputMode="decimal" placeholder="auto" className={field} />
            <p className="mt-1 text-[11px] text-ink-3">For salary, or an office-computed figure.</p>
          </div>
          <div>
            <label className="mb-1.5 block text-[12px] font-medium text-ink-3" htmlFor="tds-memo">
              Memo
            </label>
            <input id="tds-memo" name="memo" className={field} placeholder="Shed repair" />
          </div>
          <div>
            <label className="mb-1.5 block text-[12px] font-medium text-ink-3" htmlFor="tds-ref">
              Ref
            </label>
            <input id="tds-ref" name="ref_no" className={field} />
          </div>
          <label className="flex items-center gap-2 text-[12.5px] text-ink-2 lg:col-span-2">
            <input type="checkbox" name="use_alt" className="size-3.5 accent-accent" />
            Use the section&rsquo;s alternate rate (e.g. company payee, plant &amp; machinery)
          </label>
          <div className="lg:col-span-2 lg:text-right">
            <button
              type="submit"
              className="rounded-lg bg-accent px-4 py-2.5 text-[13px] font-medium text-white transition-opacity hover:opacity-90"
            >
              Post payment with TDS
            </button>
          </div>
        </form>
      </section>

      {/* -------- Quarterly summary -------- */}
      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        {[q26, q24].map((s) => (
          <section key={s.form} className="overflow-hidden rounded-xl border border-hairline bg-surface">
            <div className="flex items-baseline justify-between border-b border-hairline px-5 py-3.5">
              <h2 className="text-[15px] font-semibold tracking-tight">
                {s.form} · Q{s.quarter} {fyLabel(fy)}
              </h2>
              <span className="text-[12px] text-ink-3">
                {s.form === "26Q" ? "other than salary" : "salary"}
              </span>
            </div>
            {s.missing_pan_count > 0 && (
              <p className="border-b border-hairline bg-critical/10 px-5 py-2 text-[12px] text-critical">
                {s.missing_pan_count} payee{s.missing_pan_count === 1 ? "" : "s"} without a
                PAN — the return will reject those lines. Collect the PAN before filing.
              </p>
            )}
            {s.lines.length === 0 ? (
              <p className="px-5 py-8 text-center text-[13px] text-ink-3">
                No deductions this quarter.
              </p>
            ) : (
              <table className="w-full border-collapse">
                <thead>
                  <tr className="border-b border-hairline text-[11.5px] uppercase tracking-wide text-ink-3">
                    <th className="px-4 py-2.5 text-left font-medium">Payee</th>
                    <th className="px-4 py-2.5 text-left font-medium">PAN</th>
                    <th className="px-4 py-2.5 text-left font-medium">Sec</th>
                    <th className="px-4 py-2.5 text-right font-medium">Base</th>
                    <th className="px-4 py-2.5 text-right font-medium">TDS</th>
                  </tr>
                </thead>
                <tbody>
                  {s.lines.map((l) => (
                    <tr key={`${l.party_id}-${l.section}`} className="border-b border-hairline/60">
                      <td className={`${cell} text-left`}>{l.party_name}</td>
                      <td className={`${cell} text-left ${l.missing_pan ? "text-critical" : "text-ink-3"}`}>
                        {l.party_pan || "missing"}
                      </td>
                      <td className={`${cell} text-left text-ink-3`}>{l.section}</td>
                      <td className={`${cell} text-right`}>{inr(l.base_paise)}</td>
                      <td className={`${cell} text-right font-medium`}>{inr(l.tds_paise)}</td>
                    </tr>
                  ))}
                  <tr className="text-[13px] font-semibold">
                    <td className="px-4 py-3" colSpan={3}>Total</td>
                    <td className="px-4 py-3 text-right tabular-nums">{inr(s.total_base_paise)}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{inr(s.total_tds_paise)}</td>
                  </tr>
                </tbody>
              </table>
            )}
          </section>
        ))}
      </div>

      {/* -------- Challans -------- */}
      <section className="mt-6 overflow-hidden rounded-xl border border-hairline bg-surface">
        <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-hairline px-5 py-3.5">
          <h2 className="text-[15px] font-semibold tracking-tight">Challan deposits</h2>
          <span className="text-[12px] text-ink-3">
            {undepositedAll > 0
              ? `${inr(undepositedAll)} deducted and not yet deposited across ${fyLabel(fy)}`
              : `everything deducted in ${fyLabel(fy)} is deposited`}
          </span>
        </div>
        {challans.length > 0 && (
          <table className="w-full border-collapse">
            <thead>
              <tr className="border-b border-hairline text-[11.5px] uppercase tracking-wide text-ink-3">
                <th className="px-4 py-2.5 text-left font-medium">Paid on</th>
                <th className="px-4 py-2.5 text-left font-medium">Quarter</th>
                <th className="px-4 py-2.5 text-left font-medium">Form</th>
                <th className="px-4 py-2.5 text-left font-medium">Challan</th>
                <th className="px-4 py-2.5 text-left font-medium">BSR</th>
                <th className="px-4 py-2.5 text-right font-medium">Amount</th>
              </tr>
            </thead>
            <tbody>
              {challans.map((c) => (
                <tr key={c.id} className="border-b border-hairline/60">
                  <td className={`${cell} text-left`}>{formatDate(c.paid_on)}</td>
                  <td className={`${cell} text-left text-ink-3`}>Q{c.quarter}</td>
                  <td className={`${cell} text-left`}>{c.form}</td>
                  <td className={`${cell} text-left`}>{c.challan_no || "—"}</td>
                  <td className={`${cell} text-left text-ink-3`}>{c.bsr_code || "—"}</td>
                  <td className={`${cell} text-right`}>{inr(c.amount_paise)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <form
          action={createTdsChallan}
          className="grid gap-3 border-t border-hairline px-5 py-4 sm:grid-cols-2 lg:grid-cols-6"
        >
          <input type="hidden" name="fy" value={fy} />
          <div>
            <label className="mb-1.5 block text-[12px] font-medium text-ink-3" htmlFor="ch-form">
              Covers
            </label>
            <select id="ch-form" name="form" className={field} defaultValue="26Q">
              <option value="26Q">26Q · non-salary</option>
              <option value="24Q">24Q · salary</option>
            </select>
          </div>
          <div>
            <label className="mb-1.5 block text-[12px] font-medium text-ink-3" htmlFor="ch-q">
              Quarter to deposit
            </label>
            <select id="ch-q" name="quarter" className={field} defaultValue={String(quarter)}>
              {[1, 2, 3, 4].map((n) => (
                <option key={n} value={n}>Q{n}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1.5 block text-[12px] font-medium text-ink-3" htmlFor="ch-date">
              Deposited on
            </label>
            <input id="ch-date" name="paid_on" type="date" required defaultValue={todayIso()} className={field} />
          </div>
          <div>
            <label className="mb-1.5 block text-[12px] font-medium text-ink-3" htmlFor="ch-no">
              Challan no.
            </label>
            <input id="ch-no" name="challan_no" className={field} />
          </div>
          <div>
            <label className="mb-1.5 block text-[12px] font-medium text-ink-3" htmlFor="ch-bsr">
              BSR code
            </label>
            <input id="ch-bsr" name="bsr_code" className={field} />
          </div>
          <div className="self-end">
            <button
              type="submit"
              className="w-full rounded-lg bg-accent px-4 py-2.5 text-[13px] font-medium text-white transition-opacity hover:opacity-90"
            >
              Deposit undeposited TDS
            </button>
          </div>
          <p className="text-[11.5px] text-ink-3 sm:col-span-2 lg:col-span-6">
            Posts Dr 2300 / Cr Bank for exactly the chosen form&rsquo;s undeposited
            deductions in the quarter and stamps them with the challan — the
            amount is computed, never typed. One challan covers one return form.
          </p>
        </form>
      </section>
    </div>
  );
}
