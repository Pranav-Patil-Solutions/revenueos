import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  advanceTaxSchedule,
  ALL_RATE_GROUPS,
  caveatForGroups,
  groupSource,
  unverifiedGroups,
  partnerRemunerationCeiling,
  presumptiveIncome,
  ratesFor,
  roundToTenRupees,
  slabTax,
  taxForCompany,
  taxForFirm,
  taxForIndividual,
  TAX_YEARS,
} from "../src/lib/tax/india-it";

const L = 10_000_000; // ₹1 lakh in paise
const R = (rupees: number) => rupees * 100; // rupees → paise
const rates = TAX_YEARS[TAX_YEARS.length - 1];

// ---------------------------------------------------------------------------
// Rate resolution — an unconfirmed year must be visible, never assumed
// ---------------------------------------------------------------------------

test("ratesFor: an exact year is not provisional; a later year is, loudly", () => {
  const exact = ratesFor(rates.tax_year);
  assert.equal(exact.provisional, false);
  assert.equal(exact.rates.tax_year, rates.tax_year);

  const later = ratesFor("2030-31");
  assert.equal(later.provisional, true);
  assert.equal(later.rates.tax_year, rates.tax_year); // carried forward
  assert.match(later.caveat, /No rate table for 2030-31/);
  assert.match(later.caveat, /Confirm this year's rates before filing/);
});

test("ratesFor: a year before the earliest table throws rather than guessing", () => {
  assert.throws(() => ratesFor("1990-91"), /No income-tax rates on file/);
});

test("every shipped rate table carries its provenance", () => {
  for (const t of TAX_YEARS) {
    assert.ok(t.source.length > 0, `${t.tax_year} must say where it came from`);
    assert.equal(typeof t.verified, "boolean");
    // A verified year's source must cite actual statute text, not vibes.
    if (t.verified) {
      assert.match(t.source, /gazette|Gazette/, `${t.tax_year} verified without a gazette citation`);
    }
  }
});

test("verification is per GROUP, and callers are warned only about what they read", () => {
  // UPDATED 2026-07-22: presumptive was the last group to clear, so BOTH years
  // are now fully verified. The test therefore exercises the MECHANISM against
  // a year with no table at all — otherwise it would go vacuous the moment the
  // data became complete, which is exactly when a granularity bug would slip
  // back in unnoticed.
  for (const fy of ["2025-26", "2026-27"]) {
    assert.deepEqual(unverifiedGroups(fy), [], `${fy} should be fully verified`);
    assert.equal(ratesFor(fy).caveat, "", `${fy} computes caveat-free`);
    for (const g of ALL_RATE_GROUPS) {
      assert.ok(groupSource(fy, g), `${fy}/${g} must cite its authority`);
    }
  }

  // The machinery still reports honestly for a year nobody has entered.
  const unknown = "2019-20";
  assert.deepEqual(unverifiedGroups(unknown), ALL_RATE_GROUPS);
  const caveat = caveatForGroups(unknown, ["slabs", "presumptive"]);
  assert.match(caveat, /slab rates/);
  assert.match(caveat, /presumptive/);
  assert.match(caveat, /NOT confirmed/);
  // ...and says nothing about groups the caller did not read.
  assert.equal(/surcharge|cess/.test(caveatForGroups(unknown, ["slabs"])), false);

  // A later year still carries the table forward with a provisional note only.
  const later = ratesFor("2030-31");
  assert.equal(later.rates.tax_year, "2026-27");
  assert.match(later.caveat, /No rate table for 2030-31/);
  assert.equal(later.provisional_note.startsWith("No rate table"), true);
});

// ---------------------------------------------------------------------------
// Slabs, rebate and its marginal relief
// ---------------------------------------------------------------------------

test("new regime: nil up to the rebate limit", () => {
  assert.equal(taxForIndividual(4 * L, "new", rates).total_tax_paise, 0);
  assert.equal(taxForIndividual(8 * L, "new", rates).total_tax_paise, 0);
  const at12 = taxForIndividual(12 * L, "new", rates);
  assert.equal(at12.tax_before_rebate_paise, R(60_000));
  assert.equal(at12.rebate_paise, R(60_000)); // exactly cancelled
  assert.equal(at12.total_tax_paise, 0);
});

test("new regime: marginal relief just past the rebate limit caps tax at the excess", () => {
  // ₹12,10,000 — ₹10,000 over the limit, so tax before cess is ₹10,000, not
  // the ₹61,500 the slabs alone would give.
  const t = taxForIndividual(12 * L + R(10_000), "new", rates);
  assert.equal(t.tax_before_rebate_paise, R(61_500));
  assert.equal(t.rebate_paise, R(51_500));
  assert.equal(t.total_tax_paise, R(10_400)); // ₹10,000 + 4% cess
});

test("new regime: the relief band closes once slab tax falls below the excess", () => {
  // At ₹12,75,000 slab tax (₹71,250) is under the ₹75,000 excess, so relief
  // no longer binds and full slab tax applies.
  const t = taxForIndividual(12 * L + R(75_000), "new", rates);
  assert.equal(t.rebate_paise, 0);
  assert.equal(t.total_tax_paise, R(74_100)); // 71,250 + 4%
});

test("old regime: rebate at its own lower limit, then plain slabs", () => {
  assert.equal(taxForIndividual(5 * L, "old", rates).total_tax_paise, 0);
  // ₹6L: 5% on 2.5–5L plus 20% on the last lakh, then cess.
  const t = taxForIndividual(6 * L, "old", rates);
  assert.equal(t.tax_before_rebate_paise, R(32_500));
  assert.equal(t.rebate_paise, 0); // over the limit, and no marginal relief here
  assert.equal(t.total_tax_paise, R(33_800));
});

test("slabTax bands add up and a zero or negative base is nil", () => {
  assert.equal(slabTax(0, rates.slabs_new), 0);
  assert.equal(slabTax(-5 * L, rates.slabs_new), 0);
  assert.equal(slabTax(24 * L, rates.slabs_new), R(300_000));
  // One rupee into the top band adds exactly 30 paise… i.e. 30% of ₹1.
  assert.equal(
    slabTax(24 * L + R(1), rates.slabs_new) - slabTax(24 * L, rates.slabs_new),
    30
  );
});

// ---------------------------------------------------------------------------
// Surcharge and its marginal relief
// ---------------------------------------------------------------------------

test("no surcharge at the threshold; just above it marginal relief holds the line", () => {
  const at = taxForIndividual(50 * L, "new", rates);
  assert.equal(at.surcharge_paise, 0);

  const over = taxForIndividual(50 * L + R(10_000), "new", rates);
  assert.ok(over.surcharge_marginal_relief_paise > 0, "relief must apply");
  // The whole point: tax before cess can't exceed tax at the threshold plus
  // every rupee earned above it.
  const ceiling =
    at.tax_before_rebate_paise - at.rebate_paise + R(10_000);
  assert.equal(
    over.tax_before_rebate_paise - over.rebate_paise + over.surcharge_paise,
    ceiling
  );
  assert.equal(over.total_tax_paise, R(1_133_600));
});

test("well past a threshold the surcharge applies in full", () => {
  const t = taxForIndividual(52 * L, "new", rates);
  assert.equal(t.surcharge_marginal_relief_paise, 0);
  assert.equal(t.surcharge_paise, R(114_000)); // 10% of ₹11,40,000
  assert.equal(t.total_tax_paise, R(1_304_160));
});

test("marginal relief holds at EVERY threshold, not just the first", () => {
  // The ceiling at a higher threshold must include the surcharge already
  // running just below it. Pricing it from bare slab tax over-grants relief so
  // badly that total tax FALLS as income rises.
  for (const tier of rates.surcharge) {
    const at = taxForIndividual(tier.above_paise, "old", rates);
    const over = taxForIndividual(tier.above_paise + R(100), "old", rates);
    assert.ok(
      over.total_tax_paise >= at.total_tax_paise,
      `tax fell crossing ${tier.above_paise / L} lakh`
    );
    // Relief means the extra tax can't exceed the extra income.
    assert.ok(
      over.total_tax_paise - at.total_tax_paise <= R(100) * 1.04 + 10,
      `crossing ${tier.above_paise / L} lakh cost more than the income earned`
    );
  }
});

test("tax never falls as income rises — every entity, across every threshold", () => {
  const priced: ((i: number) => number)[] = [
    (i) => taxForIndividual(i, "old", rates).total_tax_paise,
    (i) => taxForIndividual(i, "new", rates).total_tax_paise,
    (i) => taxForFirm(i, rates).total_tax_paise,
    (i) => taxForCompany(i, false, rates).total_tax_paise,
    (i) => taxForCompany(i, true, rates).total_tax_paise,
  ];
  const thresholds = [
    ...rates.surcharge.map((t) => t.above_paise),
    ...rates.company_surcharge.map((t) => t.above_paise),
    rates.firm_surcharge.above_paise,
    12 * L,
  ];
  for (const price of priced) {
    for (const t of thresholds) {
      for (const delta of [0, R(1), R(100), R(10_000), R(100_000)]) {
        assert.ok(
          price(t + delta) >= price(t),
          `tax fell at ${t / L}L + ₹${delta / 100}`
        );
      }
    }
  }
});

test("the new regime caps surcharge below the old regime's top tier", () => {
  const income = 6 * 100 * L; // ₹6 crore, past the top tier
  const newRegime = taxForIndividual(income, "new", rates);
  const oldRegime = taxForIndividual(income, "old", rates);
  const pct = (t: typeof newRegime) =>
    (t.surcharge_paise * 100) /
    (t.tax_before_rebate_paise - t.rebate_paise);
  assert.ok(Math.round(pct(newRegime)) === rates.surcharge_cap_new);
  assert.ok(pct(oldRegime) > pct(newRegime), "old regime surcharges harder");
});

// ---------------------------------------------------------------------------
// Other entities
// ---------------------------------------------------------------------------

test("firm: flat rate plus cess, surcharge only past its threshold", () => {
  const t = taxForFirm(10 * L, rates);
  assert.equal(t.tax_before_rebate_paise, R(300_000));
  assert.equal(t.surcharge_paise, 0);
  assert.equal(t.total_tax_paise, R(312_000));

  const big = taxForFirm(200 * L, rates); // ₹2 crore, past ₹1 crore
  assert.ok(big.surcharge_paise > 0);
});

test("company: the concessional election is a lower rate with its own flat surcharge", () => {
  const normal = taxForCompany(100 * L, false, rates);
  const elected = taxForCompany(100 * L, true, rates);
  assert.equal(normal.tax_before_rebate_paise, R(2_500_000)); // 25%
  assert.equal(elected.tax_before_rebate_paise, R(2_200_000)); // 22%
  // The flat surcharge has no threshold, so there is no relief to compute.
  assert.equal(elected.surcharge_marginal_relief_paise, 0);
  assert.ok(elected.total_tax_paise < normal.total_tax_paise);
});

// ---------------------------------------------------------------------------
// Presumptive, partner remuneration, rounding, instalments
// ---------------------------------------------------------------------------

test("presumptive: digital receipts take the lower business rate", () => {
  assert.equal(presumptiveIncome("44AD", 50 * L, 50 * L, rates), R(300_000)); // 6%
  assert.equal(presumptiveIncome("44AD", 50 * L, 0, rates), R(400_000)); // 8%
  // A mix splits between the two rates.
  assert.equal(presumptiveIncome("44AD", 50 * L, 25 * L, rates), R(350_000));
  assert.equal(presumptiveIncome("44ADA", 50 * L, 0, rates), R(2_500_000)); // 50%
  assert.equal(presumptiveIncome("", 50 * L, 0, rates), 0);
});

test("presumptive: a digital figure above turnover can't invent income", () => {
  assert.equal(
    presumptiveIncome("44AD", 50 * L, 999 * L, rates),
    presumptiveIncome("44AD", 50 * L, 50 * L, rates)
  );
});

test("partner remuneration ceiling: higher-of on the first slab, then the balance rate", () => {
  // ₹10L book profit → 90% of the first ₹6L, plus 60% of the ₹4L balance.
  assert.equal(partnerRemunerationCeiling(10 * L, rates), R(780_000));
  // A tiny or negative book profit still allows the floor.
  assert.equal(partnerRemunerationCeiling(0, rates), R(300_000));
  assert.equal(partnerRemunerationCeiling(-5 * L, rates), R(300_000));
  // Where 90% of book profit beats the floor, the higher figure wins.
  assert.equal(partnerRemunerationCeiling(5 * L, rates), R(450_000));
});

test("statutory rounding goes to the nearest ten rupees, both directions", () => {
  assert.equal(roundToTenRupees(R(1_234)), R(1_230));
  assert.equal(roundToTenRupees(R(1_235)), R(1_240)); // .5 rounds up
  assert.equal(roundToTenRupees(R(1_236)), R(1_240));
  assert.equal(roundToTenRupees(0), 0);
  assert.equal(roundToTenRupees(-R(1_236)), -R(1_240));
});

test("advance tax: instalments are cumulative and add back to the total", () => {
  const s = advanceTaxSchedule(R(100_000), rates);
  assert.deepEqual(
    s.map((i) => i.instalment_paise),
    [R(15_000), R(30_000), R(30_000), R(25_000)]
  );
  assert.equal(s[s.length - 1].cumulative_paise, R(100_000));
  assert.equal(
    s.reduce((sum, i) => sum + i.instalment_paise, 0),
    R(100_000)
  );
  // Nothing owed, nothing scheduled.
  assert.equal(
    advanceTaxSchedule(0, rates).every((i) => i.instalment_paise === 0),
    true
  );
});

test("advance tax: a presumptive assessee pays everything by 15 Mar (s.408(2))", () => {
  const s = advanceTaxSchedule(R(100_000), rates, true);
  assert.equal(s.length, 1);
  assert.equal(s[0].due, "15 Mar");
  assert.equal(s[0].cumulative_percent, 100);
  assert.equal(s[0].instalment_paise, R(100_000));
});
