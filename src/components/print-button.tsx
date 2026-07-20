"use client";

/** The pack is a web page that prints; the button is the only client bit. */
export function PrintButton() {
  return (
    <button
      type="button"
      onClick={() => window.print()}
      className="rounded-lg bg-accent px-4 py-2.5 text-[13px] font-medium text-white transition-opacity hover:opacity-90 print:hidden"
    >
      Print / save as PDF
    </button>
  );
}
