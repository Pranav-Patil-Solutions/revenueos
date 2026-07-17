import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  countEmptyDates,
  fillEmptyDates,
  findMissingDateIndices,
  missingDatesText,
} from "../src/lib/review-dates";

function row(overrides: Partial<{ entry_date: string; include: boolean; row_no: number }> = {}) {
  return { entry_date: "", include: true, row_no: 1, ...overrides };
}

// ---------------------------------------------------------------------------
// fillEmptyDates — EVOLUTION.md #8 finding 1: a bulk date-fill must never
// stamp a date onto an excluded/unchecked row (it would later persist via
// saveDraftRows -> applyDraftRows and could get posted if re-included).
// ---------------------------------------------------------------------------

test("fillEmptyDates: stamps the date onto included rows missing one", () => {
  const rows = [row({ row_no: 1 }), row({ row_no: 2, entry_date: "2026-07-01" })];
  const out = fillEmptyDates(rows, "2026-07-15");
  assert.equal(out[0].entry_date, "2026-07-15");
  assert.equal(out[1].entry_date, "2026-07-01"); // already had a date — untouched
});

test("fillEmptyDates: never stamps a date onto an excluded row", () => {
  const rows = [
    row({ row_no: 1, include: false }),
    row({ row_no: 2, include: true }),
  ];
  const out = fillEmptyDates(rows, "2026-07-15");
  assert.equal(out[0].entry_date, "", "excluded row must stay dateless");
  assert.equal(out[1].entry_date, "2026-07-15");
});

test("fillEmptyDates: excluded row stays dateless even if later re-included (persistence path)", () => {
  // Mirrors the real flow: bulk-fill runs while row 1 is excluded, user then
  // re-checks it in a later edit. The fill must not have fabricated a date
  // that would now silently post.
  const afterFill = fillEmptyDates(
    [row({ row_no: 1, include: false })],
    "2026-07-15"
  );
  assert.equal(afterFill[0].entry_date, "");
  const reIncluded = { ...afterFill[0], include: true };
  assert.equal(reIncluded.entry_date, "", "no fabricated date leaks through re-inclusion");
});

test("fillEmptyDates: blank fillDate is a no-op and returns the same reference", () => {
  const rows = [row({ row_no: 1 })];
  assert.equal(fillEmptyDates(rows, ""), rows);
});

test("fillEmptyDates: does not overwrite a row that already has a date, even if included", () => {
  const rows = [row({ row_no: 1, entry_date: "2026-01-01" })];
  const out = fillEmptyDates(rows, "2026-07-15");
  assert.equal(out[0].entry_date, "2026-01-01");
});

// ---------------------------------------------------------------------------
// countEmptyDates / findMissingDateIndices — both must gate on include, same
// as fillEmptyDates, so the banner and the pre-post block agree with the fill.
// ---------------------------------------------------------------------------

test("countEmptyDates: only counts included dateless rows", () => {
  const rows = [
    row({ row_no: 1, include: true, entry_date: "" }),
    row({ row_no: 2, include: false, entry_date: "" }),
    row({ row_no: 3, include: true, entry_date: "2026-07-01" }),
  ];
  assert.equal(countEmptyDates(rows), 1);
});

test("findMissingDateIndices: returns indices, not row numbers, and skips excluded rows", () => {
  const rows = [
    row({ row_no: 5, include: true, entry_date: "" }),
    row({ row_no: 6, include: false, entry_date: "" }),
    row({ row_no: 7, include: true, entry_date: "" }),
  ];
  assert.deepEqual(findMissingDateIndices(rows), [0, 2]);
});

// ---------------------------------------------------------------------------
// missingDatesText — EVOLUTION.md #8 finding 3: derived live from the
// missing-dates Set, not frozen once at onPost() click time, so it must
// shrink correctly as clearDateFlag() removes indices.
// ---------------------------------------------------------------------------

test("missingDatesText: null when the set is empty", () => {
  assert.equal(missingDatesText([row({ row_no: 1 })], new Set()), null);
});

test("missingDatesText: singular phrasing and row number for one missing row", () => {
  const rows = [row({ row_no: 3 })];
  const text = missingDatesText(rows, new Set([0]));
  assert.match(text!, /^Row 3 needs a date/);
  assert.ok(!text!.includes("Rows"));
});

test("missingDatesText: plural phrasing, indices sorted ascending, real row_no values shown", () => {
  const rows = [row({ row_no: 9 }), row({ row_no: 2 }), row({ row_no: 5 })];
  // Sort is by array index (table order), not by row_no value — index 0 (row_no
  // 9) comes before index 2 (row_no 5) since 0 < 2.
  const text = missingDatesText(rows, new Set([2, 0])); // unsorted insertion order
  assert.equal(
    text,
    "Rows 9, 5 need a date before posting — fill the highlighted date cells."
  );
});

test("missingDatesText: shrinks correctly as indices are cleared (simulates clearDateFlag)", () => {
  const rows = [row({ row_no: 1 }), row({ row_no: 2 }), row({ row_no: 3 })];
  const missing = new Set([0, 1, 2]);
  const first = missingDatesText(rows, missing);
  assert.match(first!, /^Rows 1, 2, 3/);

  // clearDateFlag(1): row 2 fixed its date.
  missing.delete(1);
  const second = missingDatesText(rows, missing);
  assert.equal(
    second,
    "Rows 1, 3 need a date before posting — fill the highlighted date cells."
  );

  // clearDateFlag(0) and clearDateFlag(2): all fixed, banner clears entirely.
  missing.delete(0);
  missing.delete(2);
  assert.equal(missingDatesText(rows, missing), null);
});
