import { CompanySwitcher } from "./company-switcher";
import { listCompanies } from "@/lib/companies";
import { getDb } from "@/lib/db";
import { logout } from "@/lib/auth-actions";
import { formatDate, todayIso } from "@/lib/format";
import { currentFy, fyLabel } from "@/lib/fy";

const ENTITY_LABELS: Record<string, string> = {
  proprietorship: "Proprietorship",
  partnership: "Partnership / LLP",
  company: "Private limited",
};

/** Frosted sticky context bar: who the books belong to and where they stand,
 * plus who is signed in and the way out. Every field — name, entity type,
 * GSTIN, books-lock — reads off the ACTIVE company's own `companies` row
 * (RVOS-004 P6): no company_id fallback to company 1. */
export function Topbar({
  username,
  companyId,
}: {
  username: string;
  companyId: number | null;
}) {
  const db = getDb();
  const companies = listCompanies(db);
  const current = companies.find((c) => c.id === companyId) ?? null;
  const locked = (current?.books_locked_through ?? "") !== "";

  return (
    <header className="frosted sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-hairline px-8">
      <CompanySwitcher
        current={current ? { id: current.id, name: current.name } : null}
        companies={companies.map((c) => ({ id: c.id, name: c.name }))}
      />
      {current && (
        <span className="pill">
          {ENTITY_LABELS[current.entity_type] ?? current.entity_type}
        </span>
      )}
      <span className="pill">{fyLabel(currentFy())}</span>
      <span className="text-[12.5px] text-ink-3">{formatDate(todayIso())}</span>

      <span className="flex-1" />

      {current && (
        <>
          <span className="pill">
            <span
              className={`size-1.5 rounded-full ${locked ? "bg-warning" : "bg-good"}`}
            />
            {locked
              ? `Locked through ${formatDate(current.books_locked_through)}`
              : "Books open"}
          </span>
          <span className="text-[12px] text-ink-3">
            {current.gstin ? `GSTIN ${current.gstin}` : "No GSTIN"}
          </span>
        </>
      )}

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
