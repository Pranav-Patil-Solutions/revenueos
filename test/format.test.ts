import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  toPaise,
  inr,
  paiseToRupeeString,
  toCsv,
  formatDate,
  monthLabel,
  todayIso,
  thisMonth,
  formatTimestamp,
} from "../src/lib/format";

test("toPaise: rupees → integer paise, rounded", () => {
  assert.equal(toPaise(125.8), 12_580);
  assert.equal(toPaise(0), 0);
  assert.equal(toPaise(19.995), 2000); // rounds, doesn't truncate
  assert.equal(toPaise(0.1 + 0.2), 30); // float noise absorbed by rounding
  assert.equal(toPaise(-45.5), -4550);
});

test("inr: Indian digit grouping with ₹ symbol, always 2 decimals", () => {
  assert.equal(inr(1_258_000), "₹12,580.00");
  assert.equal(inr(0), "₹0.00");
  assert.equal(inr(5), "₹0.05");
  assert.equal(inr(-1_258_000), "-₹12,580.00");
});

test("paiseToRupeeString: plain decimal, no grouping/symbol", () => {
  assert.equal(paiseToRupeeString(1_258_000), "12580.00");
  assert.equal(paiseToRupeeString(0), "0.00");
  assert.equal(paiseToRupeeString(5), "0.05");
  assert.equal(paiseToRupeeString(-1_258_005), "-12580.05");
});

test("toCsv: quotes cells with comma/quote/newline, plain otherwise", () => {
  const csv = toCsv(
    ["Name", "Amount", "Note"],
    [
      ["Sharma Traders", 12_580, null],
      ["Has, comma", 100, 'has "quote"'],
      ["multi\nline", 0, ""],
    ]
  );
  const lines = csv.split("\n");
  assert.equal(lines[0], "Name,Amount,Note");
  assert.equal(lines[1], "Sharma Traders,12580,");
  assert.equal(lines[2], '"Has, comma",100,"has ""quote"""');
  // the embedded newline keeps the multi-line cell inside one logical CSV
  // record, so it does NOT start a new split()'d line at index 3/4.
  assert.ok(csv.includes('"multi\nline",0,'));
  assert.ok(csv.endsWith("\n")); // trailing newline, single one
  assert.ok(!csv.endsWith("\n\n"));
});

test("formatDate: ISO date → 'DD Mon YYYY'", () => {
  assert.equal(formatDate("2026-07-02"), "02 Jul 2026");
  assert.equal(formatDate("2026-12-31"), "31 Dec 2026");
});

test("formatDate: null/undefined → em dash, malformed → passthrough", () => {
  assert.equal(formatDate(null), "—");
  assert.equal(formatDate(undefined), "—");
  assert.equal(formatDate("not-a-date"), "not-a-date");
  // shape matches but month is out of range: MONTHS lookup misses, falls
  // back to the raw string (mirrors formatDate's own iso passthrough)
  assert.equal(formatDate("2026-13-05"), "2026-13-05");
});

test("monthLabel: 'YYYY-MM' → 'Month YYYY'", () => {
  assert.equal(monthLabel("2026-07"), "July 2026");
  assert.equal(monthLabel("2026-01"), "January 2026");
});

test("monthLabel: malformed shape passes through unchanged", () => {
  assert.equal(monthLabel("2026/07"), "2026/07");
  assert.equal(monthLabel("garbage"), "garbage");
});

test("BUG: monthLabel with an out-of-range month duplicates the input instead of passing it through", () => {
  // formatDate's equivalent out-of-range case falls back to the raw iso
  // string untouched (see the formatDate test above). monthLabel's fallback
  // expression is `MONTHS[...] ?? month` where `month` is the *whole*
  // "YYYY-MM" argument, not a re-derived label — so on a miss it stitches
  // the whole input AND the year back together instead of just returning
  // the input. Expected (consistent with formatDate): "2026-13".
  // Actual: "2026-13 2026".
  assert.equal(monthLabel("2026-13"), "2026-13");
});

test("todayIso / thisMonth: shape and consistency", () => {
  const iso = todayIso();
  assert.match(iso, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(thisMonth(), iso.slice(0, 7));
});

test("formatTimestamp: ISO instant → local 'DD Mon YYYY, HH:MM'", () => {
  const d = new Date(2026, 6, 2, 14, 5, 0); // local: 02 Jul 2026, 14:05
  assert.equal(formatTimestamp(d.toISOString()), "02 Jul 2026, 14:05");
  const midnight = new Date(2026, 0, 9, 0, 0, 0);
  assert.equal(formatTimestamp(midnight.toISOString()), "09 Jan 2026, 00:00");
});

test("formatTimestamp: null/undefined → em dash, invalid → passthrough", () => {
  assert.equal(formatTimestamp(null), "—");
  assert.equal(formatTimestamp(undefined), "—");
  assert.equal(formatTimestamp("not-a-date"), "not-a-date");
});
