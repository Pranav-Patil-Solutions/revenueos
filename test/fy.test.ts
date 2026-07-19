import { strict as assert } from "node:assert";
import { test } from "node:test";
import Database from "better-sqlite3";
import { initSchema, seedCoreData } from "../src/lib/db";
import { todayIso } from "../src/lib/format";
import {
  currentFy,
  fyEnd,
  fyKey,
  fyLabel,
  fyList,
  fyOf,
  fyStart,
  monthsOfFy,
  quarterOf,
} from "../src/lib/fy";

test("fyOf: April boundary splits financial years", () => {
  assert.equal(fyOf("2026-03-31"), "2025-26");
  assert.equal(fyOf("2026-04-01"), "2026-27");
  assert.equal(fyOf("2026-12-15"), "2026-27");
  assert.equal(fyOf("2027-01-01"), "2026-27");
  assert.equal(fyOf("2027-03-31"), "2026-27");
  assert.equal(fyOf("2027-04-01"), "2027-28");
});

test("fyOf: rejects garbage", () => {
  assert.throws(() => fyOf("not-a-date"), /Bad ISO date/);
});

test("fyStart / fyEnd: FY window edges", () => {
  assert.equal(fyStart("2026-27"), "2026-04-01");
  assert.equal(fyEnd("2026-27"), "2027-03-31");
  assert.equal(fyStart("2025-26"), "2025-04-01");
  assert.equal(fyEnd("2025-26"), "2026-03-31");
});

test("fy key validation: suffix must be start year + 1", () => {
  assert.throws(() => fyStart("2026-28"), /suffix/);
  assert.throws(() => fyStart("2026"), /Bad FY key/);
  assert.equal(fyKey(2026), "2026-27");
});

test("fyLabel", () => {
  assert.equal(fyLabel("2026-27"), "FY 2026-27");
});

test("monthsOfFy: Apr through Mar, year rolls at January", () => {
  const months = monthsOfFy("2026-27");
  assert.equal(months.length, 12);
  assert.equal(months[0], "2026-04");
  assert.equal(months[8], "2026-12");
  assert.equal(months[9], "2027-01");
  assert.equal(months[11], "2027-03");
});

test("quarterOf: Apr-start quarters", () => {
  assert.equal(quarterOf("2026-04-01"), 1);
  assert.equal(quarterOf("2026-06-30"), 1);
  assert.equal(quarterOf("2026-07-01"), 2);
  assert.equal(quarterOf("2026-09-15"), 2);
  assert.equal(quarterOf("2026-10-02"), 3);
  assert.equal(quarterOf("2026-12-31"), 3);
  assert.equal(quarterOf("2027-01-01"), 4);
  assert.equal(quarterOf("2027-03-31"), 4);
});

test("currentFy matches fyOf(today)", () => {
  assert.equal(currentFy(), fyOf(todayIso()));
});

test("fyList: spans earliest journal through current FY, newest first", () => {
  const db = new Database(":memory:");
  initSchema(db);
  seedCoreData(db);

  // Empty books → just the current FY.
  assert.deepEqual(fyList(db), [currentFy()]);

  db.prepare(
    `INSERT INTO journals (entry_date, entry_type, created_at)
     VALUES ('2024-05-10', 'sale', '2024-05-10T00:00:00Z')`
  ).run();
  const list = fyList(db);
  assert.equal(list[0], currentFy());
  assert.equal(list[list.length - 1], "2024-25");
  // Contiguous, descending.
  for (let i = 1; i < list.length; i++) {
    assert.equal(
      Number(list[i].slice(0, 4)),
      Number(list[i - 1].slice(0, 4)) - 1
    );
  }
});
