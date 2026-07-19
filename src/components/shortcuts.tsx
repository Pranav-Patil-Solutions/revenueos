"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { actionFor } from "@/lib/keymap";
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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const action = actionFor(e, {
        onVoucherScreen: pathname.startsWith("/vouchers"),
        inEditable: inEditable(e.target),
      });
      if (!action) return;
      // Esc first backs out of the overlay, then the screen.
      if (action.type === "back") {
        if (overlay) {
          e.preventDefault();
          setOverlay(false);
        }
        return; // otherwise leave Esc native (blur, close pickers)
      }
      e.preventDefault();
      switch (action.type) {
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
  }, [router, pathname, overlay]);

  return overlay ? <ShortcutOverlay onClose={() => setOverlay(false)} /> : null;
}
