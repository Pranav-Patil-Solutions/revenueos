"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/reports/gst", label: "GST filing prep" },
  { href: "/reports/trial-balance", label: "Trial balance" },
  { href: "/reports/day-book", label: "Day book" },
  { href: "/reports/pnl", label: "P&L" },
];

export function ReportTabs() {
  const pathname = usePathname();
  return (
    <div className="mt-5 flex gap-1.5 border-b border-hairline pb-3">
      {TABS.map((t) => {
        const active = pathname.startsWith(t.href);
        return (
          <Link
            key={t.href}
            href={t.href}
            className={`rounded-lg px-3 py-1.5 text-[13px] font-medium transition-colors ${
              active
                ? "bg-surface-2 text-ink"
                : "text-ink-3 hover:bg-surface-2/60 hover:text-ink-2"
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
