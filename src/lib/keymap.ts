/**
 * Tally keyboard parity — pure key-event → action mapping, no DOM. The
 * shortcuts provider owns the listener and preventDefault; this module owns
 * every decision so the rules are unit-testable.
 *
 * F4 Contra · F5 Payment · F6 Receipt · F7 Journal · F8 Sale · F9 Purchase ·
 * ^F8 Credit note · ^F9 Debit note · F2 date · ^A post · Esc back ·
 * Alt+C inline-create · ? overlay.
 */

export type VoucherNavKind =
  | "contra"
  | "payment"
  | "receipt"
  | "journal"
  | "sale"
  | "purchase"
  | "credit_note"
  | "debit_note";

export type KeyAction =
  | { type: "voucher"; kind: VoucherNavKind }
  | { type: "focus-date" }
  | { type: "submit-voucher" }
  | { type: "back" }
  | { type: "inline-create" }
  | { type: "toggle-overlay" };

/** The slice of a KeyboardEvent the mapping depends on. */
export interface KeyStroke {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/** Where the keystroke landed. */
export interface KeyContext {
  /** Any /vouchers route — ^A, F2, and Alt+C only make sense there. */
  onVoucherScreen: boolean;
  /** Focus is inside an input/textarea/select/contenteditable. */
  inEditable: boolean;
}

const FKEY_KINDS: Record<string, VoucherNavKind> = {
  F4: "contra",
  F5: "payment",
  F6: "receipt",
  F7: "journal",
  F8: "sale",
  F9: "purchase",
};

const CTRL_FKEY_KINDS: Record<string, VoucherNavKind> = {
  F8: "credit_note",
  F9: "debit_note",
};

/**
 * Map one keystroke to an action, or null to leave it alone. F-keys are
 * intercepted exactly like Tally — even while typing in a field (browser
 * refresh stays on Cmd/Ctrl+R). Plain typing is never hijacked: letter keys
 * only act with a modifier, and `?` only outside editable fields.
 */
export function actionFor(e: KeyStroke, ctx: KeyContext): KeyAction | null {
  // Cmd on macOS is left to the browser entirely.
  if (e.metaKey) return null;

  if (e.ctrlKey && !e.altKey && CTRL_FKEY_KINDS[e.key]) {
    return { type: "voucher", kind: CTRL_FKEY_KINDS[e.key] };
  }
  if (!e.ctrlKey && !e.altKey && FKEY_KINDS[e.key]) {
    return { type: "voucher", kind: FKEY_KINDS[e.key] };
  }
  if (!e.ctrlKey && !e.altKey && e.key === "F2") {
    return ctx.onVoucherScreen ? { type: "focus-date" } : null;
  }
  if (e.ctrlKey && !e.altKey && e.key.toLowerCase() === "a") {
    // Tally accept. Only on the voucher screen — everywhere else ^A stays
    // native select-all.
    return ctx.onVoucherScreen ? { type: "submit-voucher" } : null;
  }
  if (!e.ctrlKey && e.altKey && e.key.toLowerCase() === "c") {
    return ctx.onVoucherScreen ? { type: "inline-create" } : null;
  }
  if (!e.ctrlKey && !e.altKey && e.key === "Escape") {
    return { type: "back" };
  }
  if (!e.ctrlKey && !e.altKey && e.key === "?" && !ctx.inEditable) {
    return { type: "toggle-overlay" };
  }
  return null;
}

/** Rows for the `?` overlay and the voucher key rail, in display order. */
export const KEY_HINTS: { keys: string; label: string }[] = [
  { keys: "F4", label: "Contra" },
  { keys: "F5", label: "Payment" },
  { keys: "F6", label: "Receipt" },
  { keys: "F7", label: "Journal" },
  { keys: "F8", label: "Sale" },
  { keys: "F9", label: "Purchase" },
  { keys: "⌃F8", label: "Credit note" },
  { keys: "⌃F9", label: "Debit note" },
  { keys: "F2", label: "Date" },
  { keys: "⌃A", label: "Post voucher" },
  { keys: "Esc", label: "Back" },
  { keys: "⌥C", label: "Create party" },
  { keys: "⌃B", label: "Sidebar" },
  { keys: "?", label: "Shortcuts" },
];
