import { strict as assert } from "node:assert";
import { settleId } from "./helpers";
import { test } from "node:test";
import Database from "better-sqlite3";
import { book } from "../src/lib/book";
import { getCompany } from "../src/lib/companies";
import { initSchema, seedCoreData } from "../src/lib/db";
import { migrate } from "../src/lib/migrate";
import { MIGRATIONS } from "../src/lib/migrations";
import {
  dueItems,
  ruleForFy,
  tdsReturnForms,
  generateItems,
  itrItem,
  RULES,
} from "../src/lib/compliance";
import { postVoucherWithTds } from "../src/lib/vouchers";
import type { SettingsRow } from "../src/lib/types";

const FY = "2026-27";

function complianceDb(): Database.Database {
  const db = new Database(":memory:");
  initSchema(db);
  seedCoreData(db);
  migrate(db, MIGRATIONS, { now: "2026-01-01T00:00:00.000Z" });
  return db;
}

function settingsWith(
  db: Database.Database,
  patch: Partial<SettingsRow>
): SettingsRow {
  const row = getCompany(db, 1)!;
  return { ...row, ...patch };
}

// The demo settings ship with a GSTIN'd state but an empty gstin string —
// pin the assumption the regime switches rest on.
test("fresh settings have no GSTIN and no TAN", () => {
  const db = complianceDb();
  const s = settingsWith(db, {});
  assert.equal(s.gstin, "");
  assert.equal(s.tan, "");
});

// ---------------------------------------------------------------------------
// dueItems — pure due-date shapes
// ---------------------------------------------------------------------------

test("full board pins at 45 items: 24 GST + 16 TDS + 4 advance tax + 1 ITR", () => {
  const items = [...dueItems(FY, { gst: true, tds: true }), itrItem(FY, false)];
  assert.equal(items.length, 45);
  const byRule = new Map<string, number>();
  for (const i of items) byRule.set(i.rule_code, (byRule.get(i.rule_code) ?? 0) + 1);
  assert.equal(byRule.get("gstr1"), 12);
  assert.equal(byRule.get("gstr3b"), 12);
  assert.equal(byRule.get("tds-deposit"), 12);
  assert.equal(byRule.get("tds-return"), 4);
  assert.equal(byRule.get("advance-tax"), 4);
  assert.equal(byRule.get("itr"), 1);
});

test("GST returns fall due in the FOLLOWING month, across the Dec→Jan seam", () => {
  const items = dueItems(FY, { gst: true, tds: false });
  const due = (code: string, period: string) =>
    items.find((i) => i.rule_code === code && i.period === period)?.due_date;
  assert.equal(due("gstr1", "2026-04"), "2026-05-11");
  assert.equal(due("gstr3b", "2026-04"), "2026-05-20");
  assert.equal(due("gstr1", "2026-12"), "2027-01-11");
  // March of the FY files in April of the NEXT FY.
  assert.equal(due("gstr3b", "2027-03"), "2027-04-20");
});

test("TDS deposits: 7th of the next month, except March which gets 30 April", () => {
  const items = dueItems(FY, { gst: false, tds: true });
  const deposits = items.filter((i) => i.rule_code === "tds-deposit");
  assert.equal(deposits.length, 12);
  assert.equal(deposits.find((i) => i.period === "2026-04")?.due_date, "2026-05-07");
  assert.equal(deposits.find((i) => i.period === "2026-12")?.due_date, "2027-01-07");
  assert.equal(deposits.find((i) => i.period === "2027-03")?.due_date, "2027-04-30");
});

test("TDS returns: Jul 31 / Oct 31 / Jan 31, and Q4 lands 31 May in the NEXT FY", () => {
  const rets = dueItems(FY, { gst: false, tds: true }).filter(
    (i) => i.rule_code === "tds-return"
  );
  assert.deepEqual(
    rets.map((i) => [i.period, i.due_date]),
    [
      ["2026-27-Q1", "2026-07-31"],
      ["2026-27-Q2", "2026-10-31"],
      ["2026-27-Q3", "2027-01-31"],
      ["2026-27-Q4", "2027-05-31"],
    ]
  );
});

test("advance tax instalments land 15 Jun/Sep/Dec and 15 Mar", () => {
  const at = dueItems(FY, { gst: false, tds: false }).filter(
    (i) => i.rule_code === "advance-tax"
  );
  assert.deepEqual(
    at.map((i) => i.due_date),
    ["2026-06-15", "2026-09-15", "2026-12-15", "2027-03-15"]
  );
});

test("ITR due date: entity + audit tiers, income-based not form-based", () => {
  // CHANGED 2026-07-21 (RVOS-003 P1). This test previously encoded two
  // assumptions that an adversarial re-check overturned against gazette text:
  //   (a) FY 2025-26 keeps 31 Jul  — WRONG. FA 2026 s.5 substituted Expln 2
  //       to s.139(1) of the 1961 Act w.e.f. 1 Mar 2026, so the 31 Aug tier
  //       reaches AY 2026-27 = FY 2025-26.
  //   (b) a partnership's entitlement is unpinned, so show 31 Jul — WRONG.
  //       Sl.3 reads "ASSESSEE having income from profits and gains of
  //       business or profession whose accounts are not required to be
  //       audited", and Sl.3(ii) separately covers its partners. A
  //       non-audited firm filing ITR-5 is inside the tier.
  // Holding 31 Jul was not the conservative choice; it was wrong by a month.
  assert.equal(itrItem(FY, false).due_date, "2027-08-31");
  assert.equal(itrItem(FY, false, "proprietorship").due_date, "2027-08-31");
  assert.equal(itrItem(FY, false, "partnership").due_date, "2027-08-31");
  assert.equal(itrItem("2025-26", false).due_date, "2026-08-31");
  assert.equal(itrItem("2025-26", false, "partnership").due_date, "2026-08-31");
  // Companies file by 31 Oct regardless of the audit flag; audit cases too.
  assert.equal(itrItem(FY, false, "company").due_date, "2027-10-31");
  assert.equal(itrItem(FY, true).due_date, "2027-10-31");
  assert.equal(itrItem(FY, true, "partnership").due_date, "2027-10-31");
  assert.equal(itrItem(FY, false).period, FY);
});

test("a presumptive scheme collapses advance tax to the single 15 Mar item", () => {
  const db = complianceDb();
  const items = generateItems(
    book(db, 1),
    FY,
    settingsWith(db, { presumptive: "44AD" }),
    "2026-04-01"
  );
  const at = items.filter((i) => i.rule_code === "advance-tax");
  assert.equal(at.length, 1, "only the 100% instalment remains (s.408(2))");
  assert.equal(at[0].period, `${FY}-Q4`);
  assert.equal(at[0].due_date, "2027-03-15");
  // Non-presumptive books keep all four.
  const four = generateItems(book(db, 1), FY, settingsWith(db, {}), "2026-04-01");
  assert.equal(four.filter((i) => i.rule_code === "advance-tax").length, 4);
});

// Marks key on (rule_code, period) — a collision anywhere in the shapes
// would silently make one mark cover two items, this FY or a later one.
test("periods are unique per rule within an FY and across FYs", () => {
  const all = [
    ...dueItems(FY, { gst: true, tds: true }),
    itrItem(FY, false),
    ...dueItems("2027-28", { gst: true, tds: true }),
    itrItem("2027-28", false),
  ];
  const keys = new Set(all.map((i) => `${i.rule_code} ${i.period}`));
  assert.equal(keys.size, all.length);
});

test("every rule carries provenance; verified rules cite their authority", () => {
  for (const r of RULES) {
    // All six were verified 2026-07-21. A new rule added unverified will
    // (correctly) fail here — verify it or exclude it deliberately.
    assert.equal(r.verified, true, r.code);
    assert.match(
      r.source,
      /Rules 2026|ITA 2025|gst\.gov\.in/,
      `${r.code} verified without citing its authority`
    );
    assert.match(r.source, /Verified 2026-07-21/, r.code);
  }
  const items = dueItems(FY, { gst: true, tds: true });
  assert.ok(items.every((i) => i.verified === true));
});

// ---------------------------------------------------------------------------
// generateItems — regime switches, marks, derived status
// ---------------------------------------------------------------------------

test("no GSTIN and no TAN: only advance tax + ITR remain", () => {
  const db = complianceDb();
  const items = generateItems(book(db, 1), FY, settingsWith(db, {}), "2026-04-01");
  assert.equal(items.length, 5);
  assert.ok(items.every((i) => i.regime === "it"));
});

test("a GSTIN turns the GST rows on; a TAN turns the TDS rows on", () => {
  const db = complianceDb();
  const gst = generateItems(
    book(db, 1),
    FY,
    settingsWith(db, { gstin: "27ABCDE1234F1Z5" }),
    "2026-04-01"
  );
  assert.equal(gst.length, 29); // 24 GST + 4 advance + ITR
  const both = generateItems(
    book(db, 1),
    FY,
    settingsWith(db, { gstin: "27ABCDE1234F1Z5", tan: "MUMP12345A" }),
    "2026-04-01"
  );
  assert.equal(both.length, 45);
});

test("posted deductions turn TDS rows on even with no TAN in settings", () => {
  const db = complianceDb();
  db.prepare(
    `INSERT INTO parties (name, kind, gstin, pan, state_code, phone, created_at)
     VALUES ('Verma Contractors', 'supplier', '', 'ABCPV1234F', '27', '', '2026-04-01T00:00:00Z')`
  ).run();
  postVoucherWithTds(book(db, 1), {
    entry_date: "2026-05-10",
    memo: "",
    ref_no: "",
    party_id: 1,
    expense_account_code: "5900",
    base_paise: 1_000_000,
    section: "194C",
    bank_account_id: settleId(db, 1, "bank"),
  });
  const items = generateItems(book(db, 1), FY, settingsWith(db, {}), "2026-04-01");
  assert.equal(items.filter((i) => i.regime === "tds").length, 16);
  // The deduction sits in FY 2026-27 — the year before shows no TDS rows.
  const prior = generateItems(book(db, 1), "2025-26", settingsWith(db, {}), "2026-04-01");
  assert.equal(prior.filter((i) => i.regime === "tds").length, 0);
});

test("status derives from the injected today, strictly after the due date", () => {
  const db = complianceDb();
  const s = settingsWith(db, { gstin: "27ABCDE1234F1Z5" });
  const on = (today: string) =>
    generateItems(book(db, 1), FY, s, today).find(
      (i) => i.rule_code === "gstr1" && i.period === "2026-04"
    )!;
  assert.equal(on("2026-05-11").status, "pending"); // due today = still pending
  assert.equal(on("2026-05-12").status, "overdue");
  assert.equal(on("2026-04-01").status, "pending");
});

test("a mark overrides the derived status — done or na, however late", () => {
  const db = complianceDb();
  const s = settingsWith(db, { gstin: "27ABCDE1234F1Z5" });
  db.prepare(
    `INSERT INTO compliance_marks (rule_code, period, status, marked_at, note)
     VALUES ('gstr1', '2026-04', 'done', '2026-05-09T00:00:00Z', 'filed early'),
            ('gstr3b', '2026-04', 'na', '2026-06-01T00:00:00Z', '')`
  ).run();
  const items = generateItems(book(db, 1), FY, s, "2027-01-01"); // long past both dues
  const g1 = items.find((i) => i.rule_code === "gstr1" && i.period === "2026-04")!;
  const g3 = items.find((i) => i.rule_code === "gstr3b" && i.period === "2026-04")!;
  assert.equal(g1.status, "done");
  assert.equal(g1.note, "filed early");
  assert.equal(g3.status, "na");
  // An unmarked sibling in the same run still derives overdue.
  const may = items.find((i) => i.rule_code === "gstr1" && i.period === "2026-05")!;
  assert.equal(may.status, "overdue");
});

test("items come back sorted by due date", () => {
  const db = complianceDb();
  const s = settingsWith(db, { gstin: "27ABCDE1234F1Z5", tan: "MUMP12345A" });
  const items = generateItems(book(db, 1), FY, s, "2026-04-01");
  for (let i = 1; i < items.length; i++) {
    assert.ok(items[i - 1].due_date <= items[i].due_date);
  }
});

// markCompliance validates a mark against generateItems run at the server's
// own clock date — that is only sound if WHICH items exist never depends on
// today. Pin it: two distant todays must yield the identical item set, with
// only statuses differing.
test("board membership is independent of today — only statuses change", () => {
  const db = complianceDb();
  const s = settingsWith(db, { gstin: "27ABCDE1234F1Z5", tan: "MUMP12345A" });
  const keys = (today: string) =>
    generateItems(book(db, 1), FY, s, today).map((i) => `${i.rule_code} ${i.period}`);
  assert.deepEqual(keys("2026-04-01"), keys("2028-12-31"));
});

test("generateItems rejects a malformed today", () => {
  const db = complianceDb();
  assert.throws(() => generateItems(book(db, 1), FY, settingsWith(db, {}), "today"));
  assert.throws(() => generateItems(book(db, 1), FY, settingsWith(db, {}), ""));
});

// ── year authority (RVOS-003 P1) ─────────────────────────────────────────

test("a rule cites the statute that actually governed the year", () => {
  // Same dates, different law. Rendering the ITA-2025 citation on an FY
  // 2025-26 board would cite an Act that did not govern the year — right
  // number, wrong authority, which is the harder error to spot.
  const oldYear = ruleForFy("tds-deposit", "2025-26");
  assert.match(oldYear.source, /1962|1961/, "FY 2025-26 is a 1961-Act year");
  assert.equal(/Rules 2026|ITA 2025/.test(oldYear.source), false);

  const newYear = ruleForFy("tds-deposit", "2026-27");
  assert.match(newYear.source, /Rules 2026/);
});

test("TDS return forms are year-aware — 26Q/24Q did not become 140/138 retroactively", () => {
  assert.equal(tdsReturnForms("2025-26"), "26Q/24Q");
  assert.equal(tdsReturnForms("2026-27"), "Form 140/138");

  const old = dueItems("2025-26", { gst: false, tds: true }).filter(
    (i) => i.rule_code === "tds-return"
  );
  assert.equal(old.length, 4);
  for (const item of old) {
    assert.match(item.detail, /26Q\/24Q/, "FY 2025-26 files on the old forms");
    assert.equal(/140|138/.test(item.detail), false);
  }

  const current = dueItems("2026-27", { gst: false, tds: true }).filter(
    (i) => i.rule_code === "tds-return"
  );
  for (const item of current) assert.match(item.detail, /Form 140\/138/);
});

test("the rule note and the rendered detail never contradict each other", () => {
  // The bug this catches actually shipped: the FY 2026-27 note said "Form 140
  // (old 26Q)" while dueItems rendered "26Q/24Q statement" on EVERY board,
  // including FY 2025-26. Test the RENUMBERED names specifically — the current
  // note legitimately mentions "old 26Q" as a familiarity aid, so a bare
  // substring check on "26Q" gives a false positive.
  const renumbered = /140|138/;

  const oldNote = ruleForFy("tds-return", "2025-26").note;
  const oldDetail = dueItems("2025-26", { gst: false, tds: true }).find(
    (i) => i.rule_code === "tds-return"
  )!.detail;
  assert.equal(renumbered.test(oldDetail), false, "FY 2025-26 does not file on 140/138");
  assert.equal(
    /files on Form 140|filed on Form 140/.test(oldNote),
    false,
    "the FY 2025-26 note must not say the return is filed on the renumbered form"
  );

  const newNote = ruleForFy("tds-return", "2026-27").note;
  const newDetail = dueItems("2026-27", { gst: false, tds: true }).find(
    (i) => i.rule_code === "tds-return"
  )!.detail;
  assert.ok(renumbered.test(newDetail), "FY 2026-27 files on 140/138");
  assert.ok(renumbered.test(newNote), "and its note must say so");
});

test("FY 2025-26 rules are verified, and cite the 1961-Act instrument", () => {
  // The adversarial re-check cleared these on 2026-07-21. Each must cite the
  // instrument that governed THAT year — an ITA-2025 citation here would be
  // the original defect returning.
  for (const code of ["tds-deposit", "tds-return", "advance-tax", "itr"]) {
    const rule = ruleForFy(code, "2025-26");
    assert.equal(rule.verified, true, `${code} should have cleared its re-check`);
    assert.match(rule.source, /196[12]|Finance Act 2026/, `${code} must cite the right instrument`);
    assert.equal(
      /Income-tax Act 2025|ITA 2025|Rules 2026/.test(rule.source),
      false,
      `${code} cites an Act that did not govern FY 2025-26`
    );
  }
});

test("GST rules resolve identically in both years — ITA 2025 did not touch them", () => {
  for (const code of ["gstr1", "gstr3b"]) {
    assert.deepEqual(ruleForFy(code, "2025-26"), ruleForFy(code, "2026-27"));
  }
});

test("the 31 Aug tier reaches FY 2025-26 and is INCOME-based, not form-based", () => {
  // FA 2026 s.5 substituted Expln 2 to s.139(1) of the 1961 Act w.e.f.
  // 1 Mar 2026, so it bites for AY 2026-27 = FY 2025-26. Sl.3 says "assessee
  // having income from profits and gains of business or profession", so a
  // non-audited FIRM is inside it — entity type must not gate this.
  for (const entity of ["proprietorship", "partnership"] as const) {
    const item = itrItem("2025-26", false, entity);
    assert.equal(item.due_date, "2026-08-31", `${entity} non-audit is 31 Aug`);
    assert.equal(item.verified, true);
  }

  // Audit cases and companies stay at 31 Oct regardless.
  assert.equal(itrItem("2025-26", true, "proprietorship").due_date, "2026-10-31");
  assert.equal(itrItem("2025-26", false, "company").due_date, "2026-10-31");

  // And the later year keeps the same tiers under its own statute.
  assert.equal(itrItem("2026-27", false, "partnership").due_date, "2027-08-31");
});

test("a firm and a proprietorship get the SAME ITR date — the form is not the test", () => {
  // The widely repeated "31 Aug is for ITR-3/ITR-4" gloss is form-based and
  // wrong; ITR-5 (firm) qualifies on the same income test.
  assert.equal(
    itrItem("2025-26", false, "partnership").due_date,
    itrItem("2025-26", false, "proprietorship").due_date
  );
});

test("a year older than this app's coverage claims no authority at all", () => {
  // The ITR prior-authority wording cites Finance Act 2026 s.5. Applying it to
  // an open-ended "everything earlier" range would assert a law that did not
  // exist in, say, FY 2020-21 — the right-date-wrong-authority defect this
  // whole table was built to remove, reintroduced at the other end.
  const old = ruleForFy("itr", "2020-21");
  assert.equal(old.verified, false);
  assert.equal(/Finance Act 2026|31 Aug/.test(old.source), false);
  assert.match(old.source, /No authority on file/);

  // The years the app actually covers are unaffected.
  assert.equal(ruleForFy("itr", "2025-26").verified, true);
  assert.equal(ruleForFy("itr", "2026-27").verified, true);
});

