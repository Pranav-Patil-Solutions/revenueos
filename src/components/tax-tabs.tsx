"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// Filing order: computation → depreciation → TDS. Tabs whose phase hasn't
// shipped render as inert chips rather than links, so the IA is visible
// without offering a 404.
const TABS: { href: string; label: string; ready: boolean }[] = [
  { href: "/tax/computation", label: "Computation", ready: true },
  { href: "/tax/depreciation", label: "Depreciation", ready: true },
  { href: "/tax/tds", label: "TDS", ready: false },
];

/** Segmented control (macOS style) for the Tax & filing section. */
export function TaxTabs() {
  const pathname = usePathname();
  return (
    <div className="mt-5 inline-flex gap-0.5 rounded-lg bg-surface-2 p-0.5">
      {TABS.map((t) => {
        if (!t.ready) {
          return (
            <span
              key={t.href}
              title="Arriving in a later phase"
              className="cursor-default rounded-[7px] px-3 py-1.5 text-[12.5px] font-medium text-ink-3/50"
            >
              {t.label}
            </span>
          );
        }
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
