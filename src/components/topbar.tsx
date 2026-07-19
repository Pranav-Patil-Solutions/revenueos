import { getDb } from "@/lib/db";
import { formatDate, todayIso } from "@/lib/format";
import { currentFy, fyLabel } from "@/lib/fy";
import type { SettingsRow } from "@/lib/types";

const ENTITY_LABELS: Record<string, string> = {
  proprietorship: "Proprietorship",
  partnership: "Partnership / LLP",
  company: "Private limited",
};

/** Frosted sticky context bar: who the books belong to and where they stand. */
export function Topbar() {
  const s = getDb()
    .prepare("SELECT * FROM settings WHERE id = 1")
    .get() as SettingsRow;
  const locked = s.books_locked_through !== "";

  return (
    <header className="frosted sticky top-0 z-20 flex h-12 items-center gap-3 border-b border-hairline px-8">
      <span className="text-[13.5px] font-semibold tracking-tight">
        {s.company_name}
      </span>
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
    </header>
  );
}
