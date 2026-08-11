import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  extractJsonObject,
  validateExtraction,
} from "../src/lib/extraction-schema";
import { DEMO_FIXTURE } from "../src/lib/extraction";

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    row_no: 1,
    entry_date: "2026-07-01",
    particulars: "To Sales",
    ref_no: null,
    debit: 100,
    credit: null,
    entry_type: "sale",
    gst_rate: 18,
    confidence: 0.9,
    is_balance_row: false,
    ...overrides,
  };
}

function reply(rows: Record<string, unknown>[]): unknown {
  return {
    page: { party_name_hint: null, period_hint: null, has_balance_column: false, notes: "" },
    rows,
  };
}

test("extractJsonObject strips fences and prose", () => {
  const fenced = '```json\n{"a":1}\n```';
  assert.equal(extractJsonObject(fenced), '{"a":1}');
  const chatty = 'Here you go:\n{"a":{"b":2}}\nHope that helps!';
  assert.equal(extractJsonObject(chatty), '{"a":{"b":2}}');
  assert.throws(() => extractJsonObject("no json here"));
});

test("demo fixture validates: 11 rows, balance row pre-excluded, paise conversion", () => {
  const r = validateExtraction(DEMO_FIXTURE);
  assert.equal(r.rows.length, 11);
  assert.equal(r.rows[1].debit_paise, 1_180_000); // ₹11,800.00
  assert.equal(r.rows[10].is_balance_row, true);
  assert.equal(r.rows[10].include, false); // auto-excluded
  assert.equal(
    r.rows.filter((x) => x.include).length,
    10 // only the balance row is excluded by default
  );
  assert.equal(r.rows[5].settle_hint, "bank"); // NEFT receipt
  assert.equal(r.rows[8].settle_hint, "cash");
  assert.equal(r.page.has_balance_column, true);
});

test("a row with BOTH debit and credit is a hard error", () => {
  assert.throws(
    () => validateExtraction(reply([row({ debit: 100, credit: 50 })])),
    /BOTH debit and credit/
  );
});

test("unknown entry_type is a hard error", () => {
  assert.throws(
    () => validateExtraction(reply([row({ entry_type: "invoice" })])),
    /entry_type/
  );
});

test("gst_rate outside the regime set is a hard error", () => {
  assert.throws(() => validateExtraction(reply([row({ gst_rate: 17 })])), /gst_rate/);
  const ok = validateExtraction(reply([row({ gst_rate: null })]));
  assert.equal(ok.rows[0].gst_rate, null);
});

test("negative and non-numeric amounts are hard errors", () => {
  assert.throws(() => validateExtraction(reply([row({ debit: -5 })])), /negative/);
  assert.throws(() => validateExtraction(reply([row({ debit: "100" })])), /number/);
});

test("row count bounds: empty and >80 both fail", () => {
  assert.throws(() => validateExtraction(reply([])), /empty/);
  const many = Array.from({ length: 81 }, (_, i) => row({ row_no: i + 1 }));
  assert.throws(() => validateExtraction(reply(many)), /80/);
});

test("confidence is clamped to 0–1", () => {
  const r = validateExtraction(reply([row({ confidence: 1.7 }), row({ confidence: -2 })]));
  assert.equal(r.rows[0].confidence, 1);
  assert.equal(r.rows[1].confidence, 0);
});

test("null dates inherit from the previous row (ditto marks)", () => {
  const r = validateExtraction(
    reply([
      row({ entry_date: "2026-07-02" }),
      row({ entry_date: null }),
      row({ entry_date: "13/07/2026" }), // malformed → inherits too
    ])
  );
  assert.equal(r.rows[1].entry_date, "2026-07-02");
  assert.equal(r.rows[2].entry_date, "2026-07-02");
});

test("zero amounts become null (a side must be genuinely non-zero)", () => {
  const r = validateExtraction(reply([row({ debit: 0, credit: null, entry_type: "other" })]));
  assert.equal(r.rows[0].debit_paise, null);
});

test("balance rows keep include=false; ordinary rows default include=true", () => {
  const r = validateExtraction(
    reply([row({}), row({ is_balance_row: true, debit: null, credit: 500, entry_type: "opening" })])
  );
  assert.equal(r.rows[0].include, true);
  assert.equal(r.rows[1].include, false);
});
