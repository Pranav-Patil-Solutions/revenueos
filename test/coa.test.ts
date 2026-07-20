import { strict as assert } from "node:assert";
import { test } from "node:test";
import Database from "better-sqlite3";
import {
  ACCOUNT_GROUPS,
  DEFAULT_GROUP_BY_TYPE,
  SEED_GROUPS,
  groupFor,
  labelForEntity,
} from "../src/lib/coa";
import { SEED_ACCOUNTS, initSchema, seedCoreData } from "../src/lib/db";
import type { AccountRow, SettingsRow } from "../src/lib/types";

test("account groups: unique codes and orders, sections consistent", () => {
  const codes = new Set(ACCOUNT_GROUPS.map((g) => g.code));
  assert.equal(codes.size, ACCOUNT_GROUPS.length, "group codes unique");
  const orders = new Set(ACCOUNT_GROUPS.map((g) => g.order));
  assert.equal(orders.size, ACCOUNT_GROUPS.length, "orders unique");
  for (const g of ACCOUNT_GROUPS) {
    if (g.statement === "bs") {
      assert.ok(
        ["assets", "liabilities", "equity"].includes(g.section),
        `${g.code}: bs group must sit in a bs section`
      );
    } else {
      assert.ok(
        ["income", "expense"].includes(g.section),
        `${g.code}: pnl group must sit in a pnl section`
      );
    }
  }
});

test("every seeded account carries a known group", () => {
  for (const a of SEED_ACCOUNTS) {
    assert.ok(groupFor(a.group_code), `${a.code} ${a.name}: unknown group`);
    assert.equal(
      SEED_GROUPS[a.code],
      a.group_code,
      `${a.code}: SEED_GROUPS backfill map out of sync with SEED_ACCOUNTS`
    );
  }
  assert.equal(
    Object.keys(SEED_GROUPS).length,
    SEED_ACCOUNTS.length,
    "backfill map covers exactly the seeds"
  );
});

test("default group fallback exists for every account type", () => {
  for (const [type, group] of Object.entries(DEFAULT_GROUP_BY_TYPE)) {
    assert.ok(groupFor(group), `${type}: fallback group unknown`);
  }
});

test("labelForEntity: only capital varies by entity", () => {
  assert.equal(labelForEntity("capital", "proprietorship"), "Capital account");
  assert.equal(labelForEntity("capital", "partnership"), "Partners' capital");
  assert.equal(labelForEntity("capital", "company"), "Share capital");
  assert.equal(labelForEntity("fixed_assets", "company"), "Fixed assets");
  assert.equal(labelForEntity("duties_taxes", "partnership"), "Duties & taxes");
});

test("seed backfills group_code on pre-grouping books, idempotently", () => {
  const db = new Database(":memory:");
  initSchema(db);
  seedCoreData(db);

  // Simulate books created before grouping existed.
  db.prepare("UPDATE accounts SET group_code = NULL").run();

  seedCoreData(db);
  seedCoreData(db); // ×2 — must be idempotent

  const accounts = db
    .prepare("SELECT * FROM accounts ORDER BY code")
    .all() as AccountRow[];
  assert.equal(accounts.length, SEED_ACCOUNTS.length, "no duplicate seeds");
  for (const a of accounts) {
    assert.equal(a.group_code, SEED_GROUPS[a.code], `${a.code} backfilled`);
  }
});

test("settings migration lands entity defaults on existing books", () => {
  const db = new Database(":memory:");
  initSchema(db);
  seedCoreData(db);
  const s = db
    .prepare("SELECT * FROM settings WHERE id = 1")
    .get() as SettingsRow;
  assert.equal(s.entity_type, "proprietorship");
  assert.equal(s.it_regime, "new");
  assert.equal(s.presumptive, "");
  assert.equal(s.pan, "");
  assert.equal(s.tan, "");
  assert.equal(s.books_locked_through, "");
  assert.equal(s.fy_audit_case, 0);
});
