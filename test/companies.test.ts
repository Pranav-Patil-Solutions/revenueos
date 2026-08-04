import { strict as assert } from "node:assert";
import { test } from "node:test";
import Database from "better-sqlite3";
import { initSchema, seedCoreData } from "../src/lib/db";
import { migrate } from "../src/lib/migrate";
import { MIGRATIONS } from "../src/lib/migrations";
import {
  archiveCompany,
  createCompany,
  getCompany,
  listCompanies,
  renameCompany,
} from "../src/lib/companies";

/**
 * Company CRUD — RVOS-004 P3.
 *
 * Archive-only, on purpose (RVOS-004-SPEC P3): there is no deleteCompany
 * here, and there never should be one — a client's books are not something
 * this app lets anyone remove with a click.
 */

const NOW = "2026-08-04T09:00:00.000Z";

function db(): Database.Database {
  const d = new Database(":memory:");
  initSchema(d);
  seedCoreData(d);
  migrate(d, MIGRATIONS, { now: NOW });
  return d;
}

test("listCompanies returns the seeded company 1 by default, active only", () => {
  const d = db();
  const active = listCompanies(d);
  assert.equal(active.length, 1);
  assert.equal(active[0].id, 1);
});

test("createCompany makes a new, independent, active company", () => {
  const d = db();
  const id = createCompany(d, { name: "Second Client" }, NOW);
  const c = getCompany(d, id)!;
  assert.equal(c.name, "Second Client");
  assert.equal(c.company_name, "Second Client", "carried into the legacy-shaped field too");
  assert.equal(c.entity_type, "proprietorship", "defaults sensibly");
  assert.equal(c.archived_at, null);
  assert.equal(listCompanies(d).length, 2);
});

test("createCompany rejects a blank name", () => {
  const d = db();
  assert.throws(() => createCompany(d, { name: "   " }, NOW), /required/);
});

test("createCompany trims and uppercases PAN/TAN/GSTIN, trims state code", () => {
  const d = db();
  const id = createCompany(
    d,
    { name: "X", pan: " abcde1234f ", tan: " muma12345b ", gstin: " 27abcde1234f1z5 ", stateCode: " 27 " },
    NOW
  );
  const c = getCompany(d, id)!;
  assert.equal(c.pan, "ABCDE1234F");
  assert.equal(c.tan, "MUMA12345B");
  assert.equal(c.gstin, "27ABCDE1234F1Z5");
  assert.equal(c.state_code, "27");
});

test("renameCompany changes both name fields on an active company", () => {
  const d = db();
  renameCompany(d, 1, "Renamed Co");
  const c = getCompany(d, 1)!;
  assert.equal(c.name, "Renamed Co");
  assert.equal(c.company_name, "Renamed Co");
});

test("renameCompany refuses a blank name or an unknown/archived company", () => {
  const d = db();
  assert.throws(() => renameCompany(d, 1, ""), /required/);
  assert.throws(() => renameCompany(d, 999, "X"), /No such active company/);
  archiveCompany(d, 1, NOW);
  assert.throws(() => renameCompany(d, 1, "X"), /No such active company/);
});

test("archiveCompany removes a company from the default listing without deleting it", () => {
  const d = db();
  const id = createCompany(d, { name: "To Archive" }, NOW);
  archiveCompany(d, id, NOW);

  assert.deepEqual(
    listCompanies(d).map((c) => c.id),
    [1],
    "an archived company drops out of the active list"
  );
  const withArchived = listCompanies(d, { includeArchived: true });
  assert.equal(withArchived.length, 2, "but the row still exists");
  const archived = withArchived.find((c) => c.id === id)!;
  assert.notEqual(archived.archived_at, null);
});

test("archiveCompany is not idempotent — archiving twice is refused, not silently ignored", () => {
  const d = db();
  archiveCompany(d, 1, NOW);
  assert.throws(() => archiveCompany(d, 1, NOW), /No such active company/);
});

test("there is no delete — archived companies keep every row they had", () => {
  const d = db();
  const before = (
    d.prepare("SELECT COUNT(*) AS n FROM accounts WHERE company_id = 1").get() as { n: number }
  ).n;
  archiveCompany(d, 1, NOW);
  const after = (
    d.prepare("SELECT COUNT(*) AS n FROM accounts WHERE company_id = 1").get() as { n: number }
  ).n;
  assert.equal(after, before);
  assert.ok(getCompany(d, 1), "the row itself is untouched, just marked");
});
