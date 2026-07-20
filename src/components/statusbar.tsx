/** Frosted bottom status bar with live key hints (Tally parity). */
export function Statusbar() {
  const hint = (keys: string, what: string) => (
    <span>
      <kbd className="rounded border border-hairline bg-surface px-1 font-sans">{keys}</kbd>{" "}
      {what}
    </span>
  );
  return (
    <footer className="statusbar-shell frosted fixed bottom-0 right-0 z-20 flex h-8 items-center gap-4 border-t border-hairline px-8 text-[11.5px] text-ink-3">
      <span className="font-medium text-ink-2">RevenueOS</span>
      <span className="flex-1" />
      {hint("F4–F9", "Vouchers")}
      {hint("⌃A", "Post")}
      {hint("⌃B", "Sidebar")}
      {hint("?", "Keys")}
    </footer>
  );
}
