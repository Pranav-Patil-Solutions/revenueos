import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  actionFor,
  actionSurvivesModal,
  type KeyContext,
  type KeyStroke,
} from "../src/lib/keymap";

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

test("keymap: Ctrl+K opens the palette from anywhere, including mid-edit", () => {
  assert.deepEqual(actionFor(stroke("k", { ctrlKey: true }), elsewhere), {
    type: "toggle-palette",
  });
  assert.deepEqual(actionFor(stroke("K", { ctrlKey: true }), onVoucher), {
    type: "toggle-palette",
  });
  // The palette is the way OUT of a screen you are stuck typing in, so unlike
  // ^A it must not be gated on context.
  assert.deepEqual(actionFor(stroke("k", { ctrlKey: true }), typing), {
    type: "toggle-palette",
  });
});

test("keymap: bare k and Cmd+K are left alone", () => {
  assert.equal(actionFor(stroke("k"), elsewhere), null);
  assert.equal(actionFor(stroke("k"), typing), null);
  // metaKey belongs to the browser — the palette is ^K, never ⌘K.
  assert.equal(actionFor(stroke("k", { metaKey: true }), elsewhere), null);
  assert.equal(actionFor(stroke("k", { ctrlKey: true, altKey: true }), elsewhere), null);
});

test("keymap: a modal makes the Tally layer inert — ^A cannot post beneath it", () => {
  // The regression this guards: the palette opens OVER /vouchers without
  // changing the route, so onVoucherScreen stays true and ^A still mapped to
  // submit-voucher. requestSubmit() ignores the disabled post button, so
  // selecting text in the palette's search box would post the voucher.
  const accept = actionFor(stroke("a", { ctrlKey: true }), onVoucher);
  assert.deepEqual(accept, { type: "submit-voucher" });
  assert.equal(actionSurvivesModal(accept, "palette"), false);
  assert.equal(actionSurvivesModal(accept, "overlay"), false);
  assert.equal(actionSurvivesModal(accept, null), true);
});

test("keymap: while a modal is up, only its own toggle still carries", () => {
  const palette = { type: "toggle-palette" } as const;
  const overlay = { type: "toggle-overlay" } as const;
  assert.equal(actionSurvivesModal(palette, "palette"), true);
  assert.equal(actionSurvivesModal(overlay, "palette"), false);
  assert.equal(actionSurvivesModal(overlay, "overlay"), true);
  assert.equal(actionSurvivesModal(palette, "overlay"), false);

  // Nothing else survives either layer — F-keys, date, inline-create.
  for (const key of ["F5", "F8", "F2"]) {
    const a = actionFor(stroke(key), onVoucher);
    assert.ok(a, `${key} should map to an action`);
    assert.equal(actionSurvivesModal(a, "palette"), false);
    assert.equal(actionSurvivesModal(a, "overlay"), false);
  }
  const create = actionFor(stroke("c", { altKey: true }), onVoucher);
  assert.deepEqual(create, { type: "inline-create" });
  assert.equal(actionSurvivesModal(create, "palette"), false);
});

test("keymap: with no modal, every action passes through unchanged", () => {
  for (const s of [stroke("F5"), stroke("a", { ctrlKey: true }), stroke("k", { ctrlKey: true })]) {
    const a = actionFor(s, onVoucher);
    assert.ok(a);
    assert.equal(actionSurvivesModal(a, null), true);
  }
});

test("keymap: actionSurvivesModal for every KeyAction type, against every modal layer", () => {
  const actions: { name: string; action: Parameters<typeof actionSurvivesModal>[0] }[] = [
    { name: "voucher", action: { type: "voucher", kind: "sale" } },
    { name: "focus-date", action: { type: "focus-date" } },
    { name: "submit-voucher", action: { type: "submit-voucher" } },
    { name: "back", action: { type: "back" } },
    { name: "inline-create", action: { type: "inline-create" } },
    { name: "toggle-palette", action: { type: "toggle-palette" } },
    { name: "toggle-overlay", action: { type: "toggle-overlay" } },
  ];
  for (const { name, action } of actions) {
    // No modal: every action carries, unconditionally.
    assert.equal(actionSurvivesModal(action, null), true, `${name} vs null`);
    // Under the palette, only toggle-palette itself survives.
    assert.equal(
      actionSurvivesModal(action, "palette"),
      action.type === "toggle-palette",
      `${name} vs palette`
    );
    // Under the overlay, only toggle-overlay itself survives.
    assert.equal(
      actionSurvivesModal(action, "overlay"),
      action.type === "toggle-overlay",
      `${name} vs overlay`
    );
  }
});
