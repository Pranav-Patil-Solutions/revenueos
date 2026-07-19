import { strict as assert } from "node:assert";
import { test } from "node:test";
import type Database from "better-sqlite3";
import { balanceSheet, trialBalance } from "../src/lib/reports";
import type { SettingsRow } from "../src/lib/types";
import { postedDb } from "./helpers";

/** Demo books posted (Sharma Traders, July 2026, row 10 excluded):
 * AR ₹12,580 · cash ₹5,000 · bank ₹4,000 · AP ₹3,900 · GST net ₹1,680 ·
 * opening equity ₹5,000 · profit ₹11,000. All figures pinned in paise. */

function settingsOf(db: Database.Database): SettingsRow {
  return db.prepare("SELECT * FROM settings WHERE id = 1").get() as SettingsRow;
}

test("balance sheet: A = L + E with pinned demo figures at FY end", () => {
  const db = postedDb();
  const bs = balanceSheet(db, "2027-03-31", settingsOf(db));

  assert.equal(bs.fy, "2026-27");
  assert.equal(bs.balanced, true);
  assert.equal(bs.total_assets_paise, 2_158_000);
  assert.equal(bs.total_liabilities_paise, 558_000);
  assert.equal(bs.total_equity_paise, 1_600_000);
  assert.equal(
    bs.total_assets_paise,
    bs.total_liabilities_paise + bs.total_equity_paise
  );
  assert.equal(bs.retained_prior_paise, 0);
  assert.equal(bs.current_year_profit_paise, 1_100_000);

  const current = bs.groups.find((g) => g.group_code === "current_assets")!;
  const ar = current.lines.find((l) => l.code === "1200")!;
  assert.equal(ar.amount_paise, 1_258_000, "AR ₹12,580");
  assert.equal(current.total_paise, 2_158_000, "cash + bank + AR");
});

test("balance sheet: GST accounts net under duties & taxes", () => {
  const db = postedDb();
  const bs = balanceSheet(db, "2027-03-31", settingsOf(db));
  const duties = bs.groups.find((g) => g.group_code === "duties_taxes")!;
  assert.equal(duties.section, "liabilities");
  const itc = duties.lines.find((l) => l.code === "1300")!;
  assert.equal(itc.amount_paise, -90_000, "ITC nets against output GST");
  assert.equal(duties.total_paise, 168_000, "net GST payable ₹1,680");
});

test("balance sheet: as-of filtering rebuilds the position mid-period", () => {
  const db = postedDb();
  // Through 2026-07-04 only the opening (₹5,000) and sale #241 (₹11,800
  // gross @18%) exist.
  const bs = balanceSheet(db, "2026-07-04", settingsOf(db));
  assert.equal(bs.total_assets_paise, 1_680_000, "AR only");
  assert.equal(bs.current_year_profit_paise, 1_000_000, "taxable of #241");
  assert.equal(bs.total_liabilities_paise, 180_000, "CGST + SGST on #241");
  assert.equal(bs.total_equity_paise, 1_500_000);
});

test("balance sheet: empty before the first entry", () => {
  const db = postedDb();
  const bs = balanceSheet(db, "2026-06-30", settingsOf(db));
  assert.equal(bs.groups.length, 0);
  assert.equal(bs.total_assets_paise, 0);
  assert.equal(bs.retained_prior_paise, 0);
  assert.equal(bs.current_year_profit_paise, 0);
});

test("balance sheet: prior-FY profit moves to retained earnings", () => {
  const db = postedDb();
  const bs = balanceSheet(db, "2027-04-30", settingsOf(db));
  assert.equal(bs.fy, "2027-28");
  assert.equal(bs.retained_prior_paise, 1_100_000);
  assert.equal(bs.current_year_profit_paise, 0);
  assert.equal(bs.total_assets_paise, 2_158_000, "position unchanged");
  const capital = bs.groups.find((g) => g.group_code === "capital")!;
  assert.ok(
    capital.lines.some((l) => l.name === "Retained earnings (prior years)")
  );
  assert.ok(!capital.lines.some((l) => l.name === "Current year profit"));
});

test("balance sheet: capital label follows the entity type", () => {
  const db = postedDb();
  db.prepare("UPDATE settings SET entity_type = 'partnership' WHERE id = 1").run();
  const bs = balanceSheet(db, "2027-03-31", settingsOf(db));
  const capital = bs.groups.find((g) => g.group_code === "capital")!;
  assert.equal(capital.label, "Partners' capital");
});

test("balance sheet: reconciles to the trial balance at every as-of date", () => {
  const db = postedDb();
  for (const asOf of ["2026-07-04", "2026-07-10", "2026-07-15", "2027-03-31"]) {
    const tb = trialBalance(db, asOf);
    assert.equal(tb.balanced, true, `TB at ${asOf}`);
    const bs = balanceSheet(db, asOf, settingsOf(db));
    assert.equal(bs.balanced, true, `BS at ${asOf}`);
  }
});

test("balance sheet: throws on a hand-corrupted line instead of lying", () => {
  const db = postedDb();
  // Skew one debit leg. The one-sided SQL CHECK still holds, so only the
  // A = L + E guard can catch it.
  const line = db
    .prepare("SELECT id FROM journal_lines WHERE debit_paise > 0 LIMIT 1")
    .get() as { id: number };
  db.prepare(
    "UPDATE journal_lines SET debit_paise = debit_paise + 100 WHERE id = ?"
  ).run(line.id);
  assert.throws(
    () => balanceSheet(db, "2027-03-31", settingsOf(db)),
    /OUT OF BALANCE/
  );
});
