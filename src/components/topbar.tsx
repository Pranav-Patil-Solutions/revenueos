import { CompanySwitcher } from "./company-switcher";
import { listCompanies } from "@/lib/companies";
import { getDb } from "@/lib/db";
import { logout } from "@/lib/auth-actions";
import { formatDate, todayIso } from "@/lib/format";
import { currentFy, fyLabel } from "@/lib/fy";
import type { SettingsRow } from "@/lib/types";

const ENTITY_LABELS: Record<string, string> = {
  proprietorship: "Proprietorship",
  partnership: "Partnership / LLP",
  company: "Private limited",
};

/** Frosted sticky context bar: who the books belong to and where they stand,
 * plus who is signed in and the way out.
 *
 * The company NAME and the switcher come from the `companies` table, scoped
 * to the session (RVOS-004 P3). The rest of this pill — GSTIN, books-lock —
 * still reads the pre-multi-tenant `settings` singleton, which is company 1's
 * data regardless of which company is active. That is a KNOWN, TRACKED gap,
 * not an oversight: those consumers are ported to per-company reads in P4/P5,
 * same as every other settings-table reader (see HANDOFF.md). Until then this
 * strip can show company 1's GSTIN/lock state under a different company's
 * name — cosmetic staleness on a profile field, not a books read, so it does
 * not cross invariant T1. */
export function Topbar({
  username,
  companyId,
}: {
  username: string;
  companyId: number | null;
}) {
  const db = getDb();
  const s = db.prepare("SELECT * FROM settings WHERE id = 1").get() as SettingsRow;
  const locked = s.books_locked_through !== "";
  const companies = listCompanies(db);
  const current = companies.find((c) => c.id === companyId) ?? null;

  return (
    <header className="frosted sticky top-0 z-20 flex h-12 items-center gap-3 border-b border-hairline px-8">
      <CompanySwitcher
        current={current ? { id: current.id, name: current.name } : null}
        companies={companies.map((c) => ({ id: c.id, name: c.name }))}
      />
      <span className="pill">{ENTITY_LABELS[s.entity_type] ?? s.entity_type}</span>
      <span className="pill">{fyLabel(currentFy())}</span>
      <span className="text-[12.5px] text-ink-3">{formatDate(todayIso())}</span>

      <span className="flex-1" />

      <span className="pill">
        <span
          className={`size-1.5 rounded-full ${locked ? "bg-warning" : "bg-good"}`}
        />
        {locked ? `Locked through ${formatDate(s.books_locked_through)}` : "Books open"}
      </span>
      <span className="text-[12px] text-ink-3">
        {s.gstin ? `GSTIN ${s.gstin}` : "No GSTIN"}
      </span>

      <span className="h-4 w-px bg-hairline" />

      <span className="text-[12px] text-ink-3" title="Signed in">
        {username}
      </span>
      {/* A plain form, so signing out works with JavaScript disabled and is a
          POST rather than a link — a GET logout can be triggered by any image
          tag on any page the browser happens to load. */}
      <form action={logout}>
        <button
          type="submit"
          className="rounded-md px-2 py-1 text-[12px] text-ink-3 transition hover:bg-surface-2 hover:text-ink"
        >
          Sign out
        </button>
      </form>
    </header>
  );
}
