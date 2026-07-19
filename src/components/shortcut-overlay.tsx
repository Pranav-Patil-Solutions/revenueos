"use client";

import { KEY_HINTS } from "@/lib/keymap";

/** The `?` shortcut sheet — frosted scrim, Apple-style card. */
export function ShortcutOverlay({ onClose }: { onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/30 backdrop-blur-[2px]"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Keyboard shortcuts"
    >
      <div
        className="w-[420px] max-w-[calc(100vw-3rem)] rounded-2xl border border-hairline bg-surface p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-baseline justify-between">
          <h2 className="text-[16px] font-semibold tracking-tight">
            Keyboard shortcuts
          </h2>
          <span className="text-[11.5px] text-ink-3">Tally parity</span>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-x-8 gap-y-2">
          {KEY_HINTS.map((h) => (
            <div
              key={h.keys}
              className="flex items-center justify-between text-[13px]"
            >
              <span className="text-ink-2">{h.label}</span>
              <kbd className="rounded-md border border-hairline bg-surface-2 px-1.5 py-0.5 font-sans text-[11.5px] text-ink-2">
                {h.keys}
              </kbd>
            </div>
          ))}
        </div>
        <p className="mt-5 text-[11.5px] text-ink-3">
          Press <kbd className="font-sans">Esc</kbd> or click anywhere to close.
        </p>
      </div>
    </div>
  );
}
