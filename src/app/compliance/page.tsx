import { FySelect } from "@/components/fy-select";
import { markCompliance } from "@/lib/actions";
import { getCompany } from "@/lib/companies";
import { formatDate, monthLabel, todayIso } from "@/lib/format";
import { currentFy, fyLabel, fyList } from "@/lib/fy";
import {
  generateItems,
  type ComplianceItem,
  type ComplianceStatus,
} from "@/lib/compliance";
import { requireBook, userCan } from "@/lib/dal";

export const dynamic = "force-dynamic";

const PILL: Record<ComplianceStatus, { dot: string; label: string }> = {
  pending: { dot: "bg-warning", label: "Pending" },
  overdue: { dot: "bg-critical", label: "Overdue" },
  done: { dot: "bg-good", label: "Done" },
  na: { dot: "bg-baseline", label: "N/A" },
};

function StatusPill({ status }: { status: ComplianceStatus }) {
  const s = PILL[status];
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-hairline bg-surface-2 px-2.5 py-0.5 text-[11.5px] font-medium text-ink-2">
      <span className={`size-1.5 rounded-full ${s.dot}`} />
      {s.label}
    </span>
  );
}

const markBtn =
  "rounded-md border border-hairline bg-surface-2 px-2 py-1 text-[11.5px] font-medium text-ink-2 hover:text-ink";

function MarkForm({
  item,
  fy,
  canManage,
}: {
  item: ComplianceItem;
  fy: string;
  /** Marking an item off is an accounts.manage action, so a clerk sees the
   * board but cannot sign items off. */
  canManage: boolean;
}) {
  const marked = item.status === "done" || item.status === "na";
  return (
    <form action={markCompliance} className="flex items-center justify-end gap-1.5">
      <input type="hidden" name="fy" value={fy} />
      <input type="hidden" name="rule_code" value={item.rule_code} />
      <input type="hidden" name="period" value={item.period} />
      {marked ? (
        <button type="submit" disabled={!canManage} name="status" value="clear" className={markBtn}>
          Clear
        </button>
      ) : (
        <>
          <input
            name="note"
            placeholder="note"
            aria-label={`Note for ${item.label} ${item.period_label}`}
            className="w-24 rounded-md border border-hairline bg-surface-2 px-2 py-1 text-[11.5px] text-ink outline-none focus:border-accent"
          />
          <button type="submit" disabled={!canManage} name="status" value="done" className={markBtn}>
            Done
          </button>
          <button type="submit" disabled={!canManage} name="status" value="na" className={markBtn}>
            N/A
          </button>
        </>
      )}
    </form>
  );
}

export default async function CompliancePage({
  searchParams,
}: {
  searchParams: Promise<{ fy?: string }>;
}) {
  const { book, user } = await requireBook();
  // Presentation only — every action here independently requires
  // accounts.manage, so a crafted request is refused either way.
  const canManage = userCan(user, "accounts.manage");

  const sp = await searchParams;
  const books = fyList(book);
  const fys = books.includes(currentFy()) ? books : [currentFy(), ...books];
  const fy = fys.includes(sp.fy ?? "") ? sp.fy! : fys[0];
  // The active company always exists and is usable by the time a Book is
  // constructed (requireBook already asserted it) — see src/lib/dal.ts.
  const settings = getCompany(book.db, book.companyId)!;

  const today = todayIso();
  const items = generateItems(book, fy, settings, today);
  const counts = items.reduce(
    (c, i) => ((c[i.status] += 1), c),
    { pending: 0, overdue: 0, done: 0, na: 0 } as Record<ComplianceStatus, number>
  );

  // Board grouped by the month a thing falls DUE — the office works the
  // calendar forward, not by the period being reported.
  const groups: { month: string; items: ComplianceItem[] }[] = [];
  for (const item of items) {
    const month = item.due_date.slice(0, 7);
    const last = groups[groups.length - 1];
    if (last && last.month === month) last.items.push(item);
    else groups.push({ month, items: [item] });
  }

  const gstOff = settings.gstin.trim() === "";
  const tdsShown = items.some((i) => i.regime === "tds");

  return (
    <div>
      <h1 className="text-[22px] font-semibold tracking-tight">Compliance</h1>

      <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
        <form method="get" className="flex items-center gap-2">
          <FySelect fys={fys} value={fy} />
          <button
            type="submit" disabled={!canManage}
            className="rounded-lg border border-hairline bg-surface-2 px-3 py-1.5 text-[12.5px] font-medium text-ink-2 hover:text-ink"
          >
            Apply
          </button>
        </form>
        <span className="flex items-center gap-3 text-[12px] text-ink-3 tabular-nums">
          {counts.overdue > 0 && (
            <span className="font-medium text-critical">{counts.overdue} overdue</span>
          )}
          <span>{counts.pending} pending</span>
          <span>{counts.done} done</span>
          {counts.na > 0 && <span>{counts.na} n/a</span>}
        </span>
      </div>

      {items.some((i) => !i.verified) && (
        <p className="mt-4 rounded-lg border border-hairline bg-surface-2/60 px-4 py-2.5 text-[12.5px] text-ink-3">
          Due dates on this board are unconfirmed against the current statute
          and notifications — deadlines shift by notification. Verify before
          relying on one. CA to verify.
        </p>
      )}
      {(gstOff || !tdsShown) && (
        <p className="mt-2 text-[12px] text-ink-3">
          {gstOff && "GST rows are hidden until a GSTIN is set in Settings. "}
          {!tdsShown &&
            "TDS rows are hidden until a TAN is set in Settings or a deduction is posted."}
        </p>
      )}

      <div className="mt-5 flex flex-col gap-6">
        {groups.map((g) => (
          <section
            key={g.month}
            className="overflow-hidden rounded-xl border border-hairline bg-surface"
          >
            <div className="flex items-baseline justify-between border-b border-hairline px-5 py-3">
              <h2 className="text-[14px] font-semibold tracking-tight">
                {monthLabel(g.month)}
              </h2>
              <span className="text-[11.5px] text-ink-3">
                {g.items.length} due · {fyLabel(fy)}
              </span>
            </div>
            <table className="w-full border-collapse">
              <tbody>
                {g.items.map((item) => (
                  <tr
                    key={`${item.rule_code}-${item.period}`}
                    className="border-b border-hairline/60 last:border-b-0"
                  >
                    <td className="w-28 px-5 py-2.5 text-[13px] tabular-nums text-ink-2">
                      {formatDate(item.due_date)}
                    </td>
                    <td className="px-4 py-2.5">
                      <p className="text-[13px] font-medium">
                        {item.label}
                        <span className="ml-2 text-[12px] font-normal text-ink-3">
                          {item.period_label}
                        </span>
                      </p>
                      <p className="text-[12px] text-ink-3">
                        {item.detail}
                        {item.note && (
                          <span className="ml-2 italic">— {item.note}</span>
                        )}
                      </p>
                    </td>
                    <td className="w-24 px-4 py-2.5 text-center">
                      <StatusPill status={item.status} />
                    </td>
                    <td className="w-56 px-5 py-2.5">
                      <MarkForm item={item} fy={fy} canManage={canManage} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ))}
      </div>
    </div>
  );
}
