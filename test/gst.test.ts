import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  GST_RATES,
  isInterState,
  roundHalfUp,
  splitCgstSgst,
  splitExclusive,
  splitInclusive,
} from "../src/lib/tax/india-gst";

test("splitInclusive peels 18% out of a gross exactly (gate case)", () => {
  const s = splitInclusive(1_180_000, 18); // ₹11,800.00
  assert.equal(s.taxablePaise, 1_000_000);
  assert.equal(s.taxPaise, 180_000);
  assert.equal(s.grossPaise, 1_180_000);
});

test("splitInclusive: gross is always exact (complement method)", () => {
  for (const rate of GST_RATES) {
    for (const gross of [1, 2, 99, 100, 101, 236_000, 560_000, 1_180_000, 9_999_999]) {
      const s = splitInclusive(gross, rate);
      assert.equal(s.taxablePaise + s.taxPaise, gross, `gross=${gross} rate=${rate}`);
      assert.ok(s.taxPaise >= 0 && s.taxablePaise >= 0);
    }
  }
});

test("splitInclusive at 0% is a no-op", () => {
  const s = splitInclusive(123_456, 0);
  assert.equal(s.taxablePaise, 123_456);
  assert.equal(s.taxPaise, 0);
});

test("splitExclusive adds tax on top", () => {
  const s = splitExclusive(1_000_000, 18);
  assert.equal(s.taxPaise, 180_000);
  assert.equal(s.grossPaise, 1_180_000);
});

test("splitExclusive rounds half up", () => {
  // 333 * 18 / 100 = 59.94 → 60
  assert.equal(splitExclusive(333, 18).taxPaise, 60);
  // 250 * 5 / 100 = 12.5 → 13
  assert.equal(splitExclusive(250, 5).taxPaise, 13);
});

test("splitCgstSgst: odd paise never lost (gate case)", () => {
  for (const tax of [0, 1, 2, 179, 180_000, 180_001, 258_001]) {
    const { cgstPaise, sgstPaise } = splitCgstSgst(tax);
    assert.equal(cgstPaise + sgstPaise, tax, `tax=${tax}`);
    assert.ok(Math.abs(cgstPaise - sgstPaise) <= 1);
  }
});

test("splitCgstSgst: even split when tax is even", () => {
  const { cgstPaise, sgstPaise } = splitCgstSgst(180_000);
  assert.equal(cgstPaise, 90_000);
  assert.equal(sgstPaise, 90_000);
});

test("splitCgstSgst: SGST is the subtraction side on odd tax", () => {
  const { cgstPaise, sgstPaise } = splitCgstSgst(181);
  assert.equal(cgstPaise, 91); // roundHalfUp(90.5)
  assert.equal(sgstPaise, 90); // 181 − 91
});

test("isInterState needs both codes present and different", () => {
  assert.equal(isInterState("07", "27"), true);
  assert.equal(isInterState("27", "27"), false);
  assert.equal(isInterState("", "27"), false);
  assert.equal(isInterState("27", ""), false);
  assert.equal(isInterState("", ""), false);
});

test("invalid rate throws", () => {
  assert.throws(() => splitInclusive(100, 17));
  assert.throws(() => splitExclusive(100, 3));
});

test("roundHalfUp", () => {
  assert.equal(roundHalfUp(0.5), 1);
  assert.equal(roundHalfUp(1.49), 1);
  assert.equal(roundHalfUp(90.5), 91);
  assert.equal(roundHalfUp(90.49), 90);
});
