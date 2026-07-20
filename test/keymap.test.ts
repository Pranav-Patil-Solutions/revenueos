import { strict as assert } from "node:assert";
import { test } from "node:test";
import { actionFor, type KeyContext, type KeyStroke } from "../src/lib/keymap";

function stroke(key: string, mods: Partial<KeyStroke> = {}): KeyStroke {
  return {
    key,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...mods,
  };
}

const onVoucher: KeyContext = { onVoucherScreen: true, inEditable: false };
const elsewhere: KeyContext = { onVoucherScreen: false, inEditable: false };
const typing: KeyContext = { onVoucherScreen: true, inEditable: true };

test("keymap: F4–F9 map to the Tally voucher kinds", () => {
  const kinds = {
    F4: "contra",
    F5: "payment",
    F6: "receipt",
    F7: "journal",
    F8: "sale",
    F9: "purchase",
  } as const;
  for (const [key, kind] of Object.entries(kinds)) {
    assert.deepEqual(actionFor(stroke(key), elsewhere), {
      type: "voucher",
      kind,
    });
  }
});

test("keymap: Ctrl+F8 / Ctrl+F9 are the note vouchers", () => {
  assert.deepEqual(actionFor(stroke("F8", { ctrlKey: true }), elsewhere), {
    type: "voucher",
    kind: "credit_note",
  });
  assert.deepEqual(actionFor(stroke("F9", { ctrlKey: true }), elsewhere), {
    type: "voucher",
    kind: "debit_note",
  });
});

test("keymap: F-keys fire even while typing in a field (Tally style)", () => {
  assert.deepEqual(actionFor(stroke("F8"), typing), {
    type: "voucher",
    kind: "sale",
  });
  assert.deepEqual(actionFor(stroke("F4"), typing), {
    type: "voucher",
    kind: "contra",
  });
});

test("keymap: Cmd is always left to the browser", () => {
  assert.equal(actionFor(stroke("F8", { metaKey: true }), onVoucher), null);
  assert.equal(
    actionFor(stroke("a", { metaKey: true, ctrlKey: true }), onVoucher),
    null
  );
});

test("keymap: Ctrl+A posts only on the voucher screen", () => {
  assert.deepEqual(actionFor(stroke("a", { ctrlKey: true }), onVoucher), {
    type: "submit-voucher",
  });
  assert.deepEqual(actionFor(stroke("A", { ctrlKey: true, shiftKey: true }), onVoucher), {
    type: "submit-voucher",
  });
  // Elsewhere ^A stays native select-all — even in a field.
  assert.equal(actionFor(stroke("a", { ctrlKey: true }), elsewhere), null);
  assert.equal(
    actionFor(stroke("a", { ctrlKey: true }), {
      onVoucherScreen: false,
      inEditable: true,
    }),
    null
  );
});

test("keymap: F2 focuses the date only on the voucher screen", () => {
  assert.deepEqual(actionFor(stroke("F2"), onVoucher), { type: "focus-date" });
  assert.deepEqual(actionFor(stroke("F2"), typing), { type: "focus-date" });
  assert.equal(actionFor(stroke("F2"), elsewhere), null);
});

test("keymap: Alt+C inline-creates only on the voucher screen", () => {
  assert.deepEqual(actionFor(stroke("c", { altKey: true }), onVoucher), {
    type: "inline-create",
  });
  assert.equal(actionFor(stroke("c", { altKey: true }), elsewhere), null);
});

test("keymap: ? opens the overlay unless typing", () => {
  assert.deepEqual(actionFor(stroke("?", { shiftKey: true }), elsewhere), {
    type: "toggle-overlay",
  });
  assert.equal(actionFor(stroke("?", { shiftKey: true }), typing), null);
});

test("keymap: Esc maps to back; plain typing is never hijacked", () => {
  assert.deepEqual(actionFor(stroke("Escape"), typing), { type: "back" });
  for (const key of ["a", "c", "b", "1", " "]) {
    assert.equal(actionFor(stroke(key), onVoucher), null, `plain "${key}"`);
  }
});
