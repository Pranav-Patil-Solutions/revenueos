import { ExportLinks, ReportTabs } from "@/components/report-tabs";
import { FySelect } from "@/components/fy-select";
import { getDb } from "@/lib/db";
import { formatDate, inr, todayIso } from "@/lib/format";
import { fyEnd, fyLabel, fyList } from "@/lib/fy";
import { balanceSheet, type BalanceSheetGroup } from "@/lib/reports";
import type { SettingsRow } from "@/lib/types";
import { requireSession } from "@/lib/dal";

export const dynamic = "force-dynamic";

function GroupBlock({ group }: { group: BalanceSheetGroup }) {
  return (
    <div>
      <p className="border-b border-hairline px-5 py-3 text-[11.5px] font-medium uppercase tracking-wide text-ink-3">
        {group.label}
      </p>
      {group.lines.map((l, i) => (
        <div
          key={`${l.code}-${l.name}-${i}`}
          className="flex items-center justify-between px-5 py-2.5 text-[13px]"
        >
          <span className="text-ink-2">
            {l.code ? `${l.code} ${l.name}` : <em className="not-italic text-ink-3">{l.name}</em>}
          </span>
          <span className="font-medium">{inr(l.amount_paise)}</span>
        </div>
      ))}
      <div className="flex items-center justify-between border-t border-hairline/60 px-5 py-2.5 text-[13px] font-semibold">
        <span>Total {group.label.toLowerCase()}</span>
        <span>{inr(group.total_paise)}</span>
      </div>
    </div>
  );
}

export default async function BalanceSheetPage({
  searchParams,
}: {
  searchParams: Promise<{ fy?: string; as_of?: string }>;
}) {
  await requireSession();

  const sp = await searchParams;
  const db = getDb();
  const fys = fyList(db);
  const fy = fys.includes(sp.fy ?? "") ? sp.fy! : undefined;
  const asOf = /^\d{4}-\d{2}-\d{2}$/.test(sp.as_of ?? "")
    ? sp.as_of!
    : fy
      ? fyEnd(fy)
      : todayIso();

  const settings = db
    .prepare("SELECT * FROM settings WHERE id = 1")
    .get() as SettingsRow;
  const bs = balanceSheet(db, asOf, settings);
  const assets = bs.groups.filter((g) => g.section === "assets");
  const liabilities = bs.groups.filter(
    (g) => g.section === "equity" || g.section === "liabilities"
  );
  const hasData = bs.groups.length > 0;

  return (
    <div>
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight">Balance sheet</h1>
          <p className="mt-1 text-[13.5px] text-ink-3">
            As of {formatDate(asOf)} · {fyLabel(bs.fy)} — profit is rolled in as
            computed equity, never posted.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <form className="flex items-center gap-2" method="GET">
            <FySelect fys={fys} value={fy} allowBlank blankLabel="As of today" />
            <input
              type="date"
              name="as_of"
              defaultValue={sp.as_of}
              aria-label="As of date"
              className="rounded-lg border border-hairline bg-surface-2 px-3 py-1.5 text-[13px] text-ink outline-none focus:border-accent"
            />
            <button
              type="submit"
              className="rounded-lg border border-hairline bg-surface-2 px-3 py-1.5 text-[13px] font-medium text-ink-2 hover:text-ink"
            >
              Apply
            </button>
          </form>
          <ExportLinks base={`/api/export/balance-sheet?as_of=${asOf}`} />
        </div>
      </div>

      <ReportTabs />

      {!hasData ? (
        <div className="mt-6 rounded-xl border border-hairline bg-surface px-6 py-14 text-center">
          <p className="text-[13.5px] font-medium text-ink-2">Nothing on the books yet</p>
          <p className="mt-1 text-[12.5px] text-ink-3">
            Post entries and the balance sheet builds itself.
          </p>
        </div>
      ) : (
        <>
          <div
            className="mt-6 grid gap-6 lg:grid-cols-2"
            style={{ fontVariantNumeric: "tabular-nums" }}
          >
            <div className="h-fit rounded-xl border border-hairline bg-surface">
              <p className="border-b border-hairline bg-surface-2/50 px-5 py-3 text-[12.5px] font-semibold">
                Assets
              </p>
              {assets.map((g) => (
                <GroupBlock key={g.group_code} group={g} />
              ))}
              <div className="flex items-center justify-between border-t border-hairline bg-surface-2/50 px-5 py-3.5">
                <span className="text-[13.5px] font-semibold">Total assets</span>
                <span className="text-[15px] font-semibold">
                  {inr(bs.total_assets_paise)}
                </span>
              </div>
            </div>

            <div className="h-fit rounded-xl border border-hairline bg-surface">
              <p className="border-b border-hairline bg-surface-2/50 px-5 py-3 text-[12.5px] font-semibold">
                Capital &amp; liabilities
              </p>
              {liabilities.map((g) => (
                <GroupBlock key={g.group_code} group={g} />
              ))}
              <div className="flex items-center justify-between border-t border-hairline bg-surface-2/50 px-5 py-3.5">
                <span className="text-[13.5px] font-semibold">
                  Total capital &amp; liabilities
                </span>
                <span className="text-[15px] font-semibold">
                  {inr(bs.total_liabilities_paise + bs.total_equity_paise)}
                </span>
              </div>
            </div>
          </div>

          <p className="mt-4 flex items-center gap-2 text-[12px] text-ink-3">
            <span className="size-1.5 rounded-full bg-good" />
            Balanced — assets equal capital + liabilities. Current-year profit{" "}
            {inr(bs.current_year_profit_paise)}
            {bs.retained_prior_paise !== 0 &&
              ` · retained earnings ${inr(bs.retained_prior_paise)}`}
            .
          </p>
        </>
      )}
    </div>
  );
}
