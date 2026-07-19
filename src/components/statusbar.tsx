/** Frosted bottom status bar with live key hints. The Tally key rail lands
 * with the vouchers phase; until then it shows the keys that already work. */
export function Statusbar() {
  return (
    <footer className="statusbar-shell frosted fixed bottom-0 right-0 z-20 flex h-8 items-center gap-4 border-t border-hairline px-8 text-[11.5px] text-ink-3">
      <span className="font-medium text-ink-2">RevenueOS</span>
      <span className="flex-1" />
      <span>
        <kbd className="rounded border border-hairline bg-surface px-1 font-sans">⌃B</kbd>{" "}
        Sidebar
      </span>
    </footer>
  );
}
