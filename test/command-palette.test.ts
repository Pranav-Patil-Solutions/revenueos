import { strict as assert } from "node:assert";
import { test } from "node:test";
import { DESTINATIONS, matches, type Destination } from "../src/components/command-palette";

const trialBalance = DESTINATIONS.find((d) => d.label === "Trial balance")!;
const balanceSheet = DESTINATIONS.find((d) => d.label === "Balance sheet")!;
const overview = DESTINATIONS.find((d) => d.label === "Overview")!;

test("an empty query matches everything", () => {
  assert.ok(matches("", trialBalance));
  assert.ok(matches("", overview));
});

test("a subsequence match finds the destination the way daily typing would", () => {
  // "tb" -> T[rial] b[alance]: t at index 0, b later — in order.
  assert.ok(matches("tb", trialBalance));
  // "bs" -> [balance] s[heet]: b at index 0, s later (in "sheet") — in order.
  assert.ok(matches("bs", balanceSheet));
});

test("a substring match against label+group also matches, not just subsequence", () => {
  // "statements" is the GROUP for trial balance, not in the label at all —
  // proves the haystack includes group, not just label.
  assert.ok(matches("statements", trialBalance));
});

test("the subsequence scan is order-sensitive, not a bag-of-letters check", () => {
  // A synthetic fixture, not a real DESTINATIONS entry — real labels' group
  // names can accidentally satisfy the substring fallback for either order,
  // which would make this test pass for the wrong reason. "ab" is a real
  // subsequence of "banana" fixture below; "ba" is not, because the scan is
  // forward-only and the first 'a' comes before any 'b'.
  const fixture: Destination = { href: "/x", label: "abc", group: "zzz" };
  assert.ok(matches("ab", fixture), "'ab' should match 'abc' in order");
  assert.equal(matches("ba", fixture), false, "'ba' is not a subsequence of 'abc'");
});

test("whitespace in the query is stripped before matching", () => {
  assert.ok(matches("t b", trialBalance));
  assert.ok(matches("  tb  ", trialBalance));
});

test("matching is case-insensitive", () => {
  assert.ok(matches("TB", trialBalance));
  assert.ok(matches("Trial", trialBalance));
});

test("a query with no relationship to the destination does not match", () => {
  assert.equal(matches("xyz123", trialBalance), false);
});

test("every DESTINATIONS entry matches its own exact label", () => {
  // A destination that can't find itself by its own name would be a real
  // regression a user would hit immediately.
  for (const d of DESTINATIONS) {
    assert.ok(
      matches(d.label.toLowerCase(), d),
      `"${d.label}" does not match its own label`
    );
  }
});

test("DESTINATIONS has no duplicate hrefs", () => {
  // Two entries for the same route would show twice in the palette.
  const hrefs = DESTINATIONS.map((d: Destination) => d.href);
  assert.equal(new Set(hrefs).size, hrefs.length);
});
