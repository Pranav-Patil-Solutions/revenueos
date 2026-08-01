"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { actionFor, actionSurvivesModal } from "@/lib/keymap";
import { CommandPalette } from "./command-palette";
import { ShortcutOverlay } from "./shortcut-overlay";

/** Custom events the voucher form listens for — keeps the global key layer
 * decoupled from form internals. */
export const FOCUS_DATE_EVENT = "revenueos:focus-date";
export const SUBMIT_VOUCHER_EVENT = "revenueos:submit-voucher";
export const INLINE_CREATE_EVENT = "revenueos:inline-create";

function inEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    target.isContentEditable
  );
}

/** Global Tally-key layer. Mounted once in the root layout. */
export function Shortcuts() {
  const router = useRouter();
  const pathname = usePathname();
  const [overlay, setOverlay] = useState(false);
  const [palette, setPalette] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const action = actionFor(e, {
        onVoucherScreen: pathname.startsWith("/vouchers"),
        inEditable: inEditable(e.target),
      });
      if (!action) return;
      // Esc backs out of whatever is layered on top, innermost first, before
      // it means anything to the screen underneath.
      if (action.type === "back") {
        if (palette) {
          e.preventDefault();
          setPalette(false);
        } else if (overlay) {
          e.preventDefault();
          setOverlay(false);
        }
        return; // otherwise leave Esc native (blur, close pickers)
      }
      // Anything layered over the screen owns the keyboard until it closes —
      // otherwise ^A in the palette's search box posts the voucher beneath it.
      if (!actionSurvivesModal(action, palette ? "palette" : overlay ? "overlay" : null)) {
        return;
      }
      e.preventDefault();
      // The gate above is what keeps the two layers mutually exclusive: while
      // either is up, only its OWN toggle reaches here. So neither case has to
      // close the other — reaching one proves the other is already closed.
      switch (action.type) {
        case "toggle-palette":
          setPalette((v) => !v);
          break;
        case "voucher":
          router.push(`/vouchers?kind=${action.kind}`);
          break;
        case "focus-date":
          window.dispatchEvent(new CustomEvent(FOCUS_DATE_EVENT));
          break;
        case "submit-voucher":
          window.dispatchEvent(new CustomEvent(SUBMIT_VOUCHER_EVENT));
          break;
        case "inline-create":
          window.dispatchEvent(new CustomEvent(INLINE_CREATE_EVENT));
          break;
        case "toggle-overlay":
          setOverlay((v) => !v);
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router, pathname, overlay, palette]);

  return (
    <>
      {palette && <CommandPalette onClose={() => setPalette(false)} />}
      {overlay && <ShortcutOverlay onClose={() => setOverlay(false)} />}
    </>
  );
}
