import { ExportLinks } from "@/components/report-tabs";
import { FySelect } from "@/components/fy-select";
import { TaxTabs } from "@/components/tax-tabs";
import { createAsset, disposeAsset, postDepreciationEntry } from "@/lib/actions";
import { formatDate, inr, todayIso } from "@/lib/format";
import { currentFy, fyKey, fyLabel, fyList, fyStartYear } from "@/lib/fy";
import {
  blockFor,
  depreciationSchedule,
  HALF_YEAR_DAYS,
  IT_BLOCKS,
  postedDepreciation,
} from "@/lib/tax/depreciation";
import type { FixedAssetRow } from "@/lib/types";
import { requireBook, userCan } from "@/lib/dal";

export const dynamic = "force-dynamic";

const field =
  "w-full rounded-lg border border-hairline bg-surface-2 px-3 py-2 text-[13px] text-ink outline-none focus:border-accent";
const cell = "px-4 py-2.5 text-[13px] tabular-nums";

/** FYs worth offering: whatever the books span, plus any year an asset was
 * put to use or sold (assets can predate the first journal). */
function fyOptions(assets: FixedAssetRow[], fromBooks: string[]): string[] {
  const years = new Set(fromBooks.map(fyStartYear));
  years.add(fyStartYear(currentFy()));
  for (const a of assets) {
    for (const d of [a.purchase_date, a.put_to_use_date, a.disposed_date]) {
      if (d) {
        const y = Number(d.slice(0, 4));
        years.add(Number(d.slice(5, 7)) >= 4 ? y : y - 1);
      }
    }
  }
  return [...years].sort((a, b) => b - a).map(fyKey);
}

export default async function DepreciationPage({
  searchParams,
}: {
  searchParams: Promise<{ fy?: string; posted?: string }>;
}) {
  const { book, user } = await requireBook();
  // Presentation only — every action here independently requires
  // accounts.manage, so a crafted request is refused either way.
  const canManage = userCan(user, "accounts.manage");
  // Presentation only — the actions independently require entry.post.
  const canPost = userCan(user, "entry.post");

  const sp = await searchParams;
  const assets = book.all(
    "SELECT * FROM fixed_assets WHERE company_id = @company_id ORDER BY purchase_date, id"
  ) as FixedAssetRow[];
  const fys = fyOptions(assets, fyList(book));
  const fy = fys.includes(sp.fy ?? "") ? sp.fy! : fys[0];

  const schedule = depreciationSchedule(book, fy);
  const posted = postedDepreciation(book, fy);
  const live = schedule.blocks.filter(
    (b) =>
      b.opening_paise !== 0 ||
      b.additions_full_paise !== 0 ||
      b.additions_half_paise !== 0 ||
      b.disposals_paise !== 0 ||
      b.closing_paise !== 0
  );

  return (
    <div>
      <h1 className="text-[22px] font-semibold tracking-tight">Tax &amp; filing</h1>
      <TaxTabs />

      <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
        <form method="get" className="flex items-center gap-2">
          <FySelect fys={fys} value={fy} />
          <button
            type="submit" disabled={!canManage}
            className="rounded-lg border border-hairline bg-surface-2 px-3 py-1.5 text-[12.5px] font-medium text-ink-2 hover:text-ink"
          >
            Apply
          </button>
        </form>
        <ExportLinks base={`/api/export/depreciation?fy=${fy}`} />
      </div>

      {posted && posted.amount_paise !== schedule.total_depreciation_paise && (
        <p className="mt-4 rounded-lg border border-critical/40 bg-critical/10 px-4 py-2.5 text-[12.5px] text-critical">
          The register has changed since this year was posted: the schedule now
          works out to {inr(schedule.total_depreciation_paise)}, but the books
          carry {inr(posted.amount_paise)} (journal #{posted.id}). Books are
          post-only — correct the difference with a manual voucher, or the
          statements and this schedule will disagree.
        </p>
      )}

      {sp.posted && (
        <p className="mt-4 rounded-lg border border-hairline bg-surface-2/60 px-4 py-2.5 text-[12.5px] text-ink-2">
          Depreciation posted as journal #{sp.posted}.
        </p>
      )}

      {/* ---------------- Block schedule ---------------- */}
      <section className="mt-5 overflow-hidden rounded-xl border border-hairline bg-surface">
        <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-hairline px-5 py-3.5">
          <h2 className="text-[15px] font-semibold tracking-tight">
            Block schedule · {fyLabel(fy)}
          </h2>
          <p className="text-[12px] text-ink-3">
            IT-Act written-down value. Assets in use under {HALF_YEAR_DAYS} days
            take half the rate. CA to verify.
          </p>
        </div>

        {live.length === 0 ? (
          <p className="px-5 py-10 text-center text-[13px] text-ink-3">
            No assets in this year yet — add one below to build the schedule.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[860px] border-collapse">
              <thead>
                <tr className="border-b border-hairline text-[11.5px] uppercase tracking-wide text-ink-3">
                  <th className="px-4 py-2.5 text-left font-medium">Block</th>
                  <th className="px-4 py-2.5 text-right font-medium">Rate</th>
                  <th className="px-4 py-2.5 text-right font-medium">Opening</th>
                  <th className="px-4 py-2.5 text-right font-medium">
                    Additions (full)
                  </th>
                  <th className="px-4 py-2.5 text-right font-medium">
                    Additions (half)
                  </th>
                  <th className="px-4 py-2.5 text-right font-medium">Disposals</th>
                  <th className="px-4 py-2.5 text-right font-medium">
                    Depreciation
                  </th>
                  <th className="px-4 py-2.5 text-right font-medium">Closing</th>
                </tr>
              </thead>
              <tbody>
                {live.map((b) => (
                  <tr key={b.block} className="border-b border-hairline/60">
                    <td className={`${cell} text-left`}>
                      {blockFor(b.block)?.label ?? b.block}
                      {b.opening_overridden && (
                        <span className="ml-2 rounded-full border border-hairline px-2 py-0.5 text-[10.5px] text-ink-3">
                          opening set
                        </span>
                      )}
                    </td>
                    <td className={`${cell} text-right text-ink-3`}>{b.rate}%</td>
                    <td className={`${cell} text-right`}>{inr(b.opening_paise)}</td>
                    <td className={`${cell} text-right`}>
                      {inr(b.additions_full_paise)}
                    </td>
                    <td className={`${cell} text-right`}>
                      {inr(b.additions_half_paise)}
                    </td>
                    <td className={`${cell} text-right`}>
                      {inr(b.disposals_paise)}
                    </td>
                    <td className={`${cell} text-right font-medium`}>
                      {inr(b.depreciation_paise)}
                    </td>
                    <td className={`${cell} text-right`}>{inr(b.closing_paise)}</td>
                  </tr>
                ))}
                <tr className="text-[13px] font-semibold">
                  <td className="px-4 py-3 text-left" colSpan={6}>
                    Total
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {inr(schedule.total_depreciation_paise)}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {inr(schedule.total_closing_paise)}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-hairline px-5 py-4">
          <p className="text-[12.5px] text-ink-3">
            {posted ? (
              <>
                Posted on {formatDate(posted.entry_date)} as journal #{posted.id}.
                Books are post-only — correct with a manual reversing entry.
              </>
            ) : (
              <>
                Books Dr 5800 Depreciation / Cr 1590 Accumulated Depreciation,
                dated 31 Mar. One entry per year.
              </>
            )}
          </p>
          {!posted &&
            schedule.total_depreciation_paise > 0 &&
            (canPost ? (
              <form action={postDepreciationEntry}>
                <input type="hidden" name="fy" value={fy} />
                <button
                  type="submit" disabled={!canManage}
                  className="rounded-lg bg-accent px-4 py-2 text-[13px] font-medium text-white transition-opacity hover:opacity-90"
                >
                  Post {inr(schedule.total_depreciation_paise)} for {fyLabel(fy)}
                </button>
              </form>
            ) : (
              // The schedule itself stays fully visible — a clerk reading it is
              // useful. Only the act of writing it to the books is withheld.
              <p className="text-[12px] text-ink-3">
                An accountant posts this entry.
              </p>
            ))}
        </div>
      </section>

      {/* ---------------- Register ---------------- */}
      <section className="mt-6 overflow-hidden rounded-xl border border-hairline bg-surface">
        <h2 className="border-b border-hairline px-5 py-3.5 text-[15px] font-semibold tracking-tight">
          Fixed-asset register
        </h2>
        {assets.length === 0 ? (
          <p className="px-5 py-10 text-center text-[13px] text-ink-3">
            No assets yet.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] border-collapse">
              <thead>
                <tr className="border-b border-hairline text-[11.5px] uppercase tracking-wide text-ink-3">
                  <th className="px-4 py-2.5 text-left font-medium">Asset</th>
                  <th className="px-4 py-2.5 text-left font-medium">Block</th>
                  <th className="px-4 py-2.5 text-right font-medium">Cost</th>
                  <th className="px-4 py-2.5 text-left font-medium">Bought</th>
                  <th className="px-4 py-2.5 text-left font-medium">In use from</th>
                  <th className="px-4 py-2.5 text-left font-medium">Disposal</th>
                </tr>
              </thead>
              <tbody>
                {assets.map((a) => (
                  <tr key={a.id} className="border-b border-hairline/60">
                    <td className={`${cell} text-left`}>{a.name}</td>
                    <td className={`${cell} text-left text-ink-3`}>
                      {blockFor(a.block)?.label ?? a.block}
                    </td>
                    <td className={`${cell} text-right`}>{inr(a.cost_paise)}</td>
                    <td className={`${cell} text-left text-ink-3`}>
                      {formatDate(a.purchase_date)}
                    </td>
                    <td className={`${cell} text-left text-ink-3`}>
                      {a.put_to_use_date ? (
                        formatDate(a.put_to_use_date)
                      ) : (
                        <span className="text-ink-3">not in use</span>
                      )}
                    </td>
                    <td className={`${cell} text-left`}>
                      {a.disposed_date ? (
                        <span className="text-ink-3">
                          {formatDate(a.disposed_date)} ·{" "}
                          {inr(a.disposal_paise ?? 0)}
                        </span>
                      ) : (
                        <form
                          action={disposeAsset}
                          className="flex flex-wrap items-center gap-1.5"
                        >
                          <input type="hidden" name="id" value={a.id} />
                          <input
                            type="date"
                            name="disposed_date"
                            required
                            defaultValue={todayIso()}
                            aria-label={`Disposal date for ${a.name}`}
                            className="rounded-md border border-hairline bg-surface-2 px-2 py-1 text-[12px] text-ink outline-none focus:border-accent"
                          />
                          <input
                            type="text"
                            name="disposal"
                            required
                            inputMode="decimal"
                            placeholder="Proceeds ₹"
                            aria-label={`Sale proceeds for ${a.name}`}
                            className="w-28 rounded-md border border-hairline bg-surface-2 px-2 py-1 text-[12px] text-ink outline-none focus:border-accent"
                          />
                          <button
                            type="submit" disabled={!canManage}
                            className="rounded-md border border-hairline px-2 py-1 text-[12px] font-medium text-ink-2 hover:text-accent"
                          >
                            Dispose
                          </button>
                        </form>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <form
          action={createAsset}
          className="grid gap-3 border-t border-hairline px-5 py-4 sm:grid-cols-2 lg:grid-cols-6"
        >
          <div className="lg:col-span-2">
            <label className="mb-1.5 block text-[12px] font-medium text-ink-3" htmlFor="asset-name">
              Asset
            </label>
            <input id="asset-name" name="name" required className={field} placeholder="Dell laptop" />
          </div>
          <div>
            <label className="mb-1.5 block text-[12px] font-medium text-ink-3" htmlFor="asset-block">
              Block
            </label>
            <select id="asset-block" name="block" required className={field} defaultValue="plant">
              {IT_BLOCKS.map((b) => (
                <option key={b.code} value={b.code}>
                  {b.label} · {b.rate}%
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1.5 block text-[12px] font-medium text-ink-3" htmlFor="asset-cost">
              Cost ₹
            </label>
            <input id="asset-cost" name="cost" required inputMode="decimal" className={field} placeholder="1,00,000" />
          </div>
          <div>
            <label className="mb-1.5 block text-[12px] font-medium text-ink-3" htmlFor="asset-bought">
              Bought
            </label>
            <input id="asset-bought" name="purchase_date" type="date" required defaultValue={todayIso()} className={field} />
          </div>
          <div>
            <label className="mb-1.5 block text-[12px] font-medium text-ink-3" htmlFor="asset-inuse">
              In use from
            </label>
            <input id="asset-inuse" name="put_to_use_date" type="date" defaultValue={todayIso()} className={field} />
          </div>
          <div className="lg:col-span-6">
            <button
              type="submit" disabled={!canManage}
              className="rounded-lg bg-accent px-4 py-2.5 text-[13px] font-medium text-white transition-opacity hover:opacity-90"
            >
              Add asset
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
