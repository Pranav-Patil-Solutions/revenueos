"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// Statement order: TB → P&L → BS → GST → Day book.
const TABS = [
  { href: "/reports/trial-balance", label: "Trial balance" },
  { href: "/reports/pnl", label: "P&L" },
  { href: "/reports/balance-sheet", label: "Balance sheet" },
  { href: "/reports/gst", label: "GST filing prep" },
  { href: "/reports/day-book", label: "Day book" },
];

/** Segmented control (macOS style): filled track, floating active segment. */
export function ReportTabs() {
  const pathname = usePathname();
  return (
    <div className="mt-5 inline-flex gap-0.5 rounded-lg bg-surface-2 p-0.5">
      {TABS.map((t) => {
        const active = pathname.startsWith(t.href);
        return (
          <Link
            key={t.href}
            href={t.href}
            className={`rounded-[7px] px-3 py-1.5 text-[12.5px] font-medium transition-colors ${
              active
                ? "bg-surface text-ink shadow-[0_1px_2px_rgba(0,0,0,0.08)]"
                : "text-ink-2 hover:text-ink"
            }`}
          >
            {t.label}
          </Link>
        );
      })}
    </div>
  );
}

/** Small pill link pair for a report's CSV/JSON exports. */
export function ExportLinks({ base }: { base: string }) {
  const join = base.includes("?") ? "&" : "?";
  return (
    <span className="inline-flex gap-1.5">
      {(["csv", "json"] as const).map((f) => (
        <a
          key={f}
          href={`${base}${join}format=${f}`}
          className="rounded-full border border-hairline bg-surface-2 px-2.5 py-0.5 text-[11.5px] font-medium text-ink-2 transition-colors hover:text-accent"
        >
          {f.toUpperCase()}
        </a>
      ))}
    </span>
  );
}
