"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

type Destination = { href: string; label: string; group: string };

/** Every screen the app has, grouped the way the sidebar groups them. */
const DESTINATIONS: Destination[] = [
  { href: "/", label: "Overview", group: "Books" },
  { href: "/capture", label: "Capture a page", group: "Ledger entry" },
  { href: "/vouchers", label: "Vouchers", group: "Ledger entry" },
  { href: "/imports", label: "Imports", group: "Ledger entry" },
  { href: "/documents", label: "Documents", group: "Books" },
  { href: "/parties", label: "Parties", group: "Books" },
  { href: "/reports", label: "Reports", group: "Statements" },
  { href: "/reports/trial-balance", label: "Trial balance", group: "Statements" },
  { href: "/reports/pnl", label: "Profit & loss", group: "Statements" },
  { href: "/reports/balance-sheet", label: "Balance sheet", group: "Statements" },
  { href: "/reports/day-book", label: "Day book", group: "Statements" },
  { href: "/reports/gst", label: "GST returns", group: "Statements" },
  { href: "/tax", label: "Tax", group: "Tax & filing" },
  { href: "/tax/computation", label: "Tax computation", group: "Tax & filing" },
  { href: "/tax/depreciation", label: "Depreciation", group: "Tax & filing" },
  { href: "/tax/tds", label: "TDS", group: "Tax & filing" },
  { href: "/compliance", label: "Compliance calendar", group: "Tax & filing" },
  { href: "/pack", label: "CA pack", group: "Tax & filing" },
  { href: "/settings", label: "Settings", group: "Settings" },
  { href: "/settings/accounts", label: "Chart of accounts", group: "Settings" },
];

/** Subsequence match, so "tb" finds "Trial balance" and "bs" the balance
 * sheet — the way anyone who uses the app daily would type. */
function matches(query: string, d: Destination): boolean {
  const q = query.toLowerCase().replace(/\s+/g, "");
  if (q === "") return true;
  const hay = `${d.label} ${d.group}`.toLowerCase();
  if (hay.includes(q)) return true;
  let i = 0;
  for (const ch of d.label.toLowerCase()) {
    if (ch === q[i]) i++;
    if (i === q.length) return true;
  }
  return false;
}

export function CommandPalette({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const results = useMemo(
    () => DESTINATIONS.filter((d) => matches(query, d)),
    [query]
  );

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const go = (d: Destination | undefined) => {
    if (!d) return;
    router.push(d.href);
    onClose();
  };

  return (
    <div
      className="palette-scrim"
      role="dialog"
      aria-modal="true"
      aria-label="Go to"
      onClick={onClose}
    >
      <div className="palette-card" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="palette-input"
          placeholder="Go to… (trial balance, GST, parties)"
          value={query}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => {
            // A new query means a new result list — the highlight belongs on
            // its best match, not on whatever row index survived.
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((i) => Math.min(i + 1, results.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((i) => Math.max(i - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              go(results[active]);
            } else if (e.key === "Escape") {
              e.preventDefault();
              onClose();
            }
          }}
        />

        <div className="max-h-[320px] overflow-y-auto p-1.5">
          {results.length === 0 ? (
            <p className="px-3 py-6 text-center text-[12.5px] text-ink-3">
              Nothing matches “{query}”.
            </p>
          ) : (
            results.map((d, i) => (
              <div
                key={d.href}
                className="palette-row"
                data-active={i === active}
                onPointerEnter={() => setActive(i)}
                onClick={() => go(d)}
              >
                <span className="flex-1">{d.label}</span>
                <span className="text-[11px] text-ink-3">{d.group}</span>
              </div>
            ))
          )}
        </div>

        <div className="flex justify-between border-t border-hairline px-4 py-2 text-[11px] text-ink-3">
          <span>↑↓ move · ↵ open</span>
          <span>Esc close</span>
        </div>
      </div>
    </div>
  );
}
