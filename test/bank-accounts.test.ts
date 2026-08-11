import { strict as assert } from "node:assert";
import { test } from "node:test";
import Database from "better-sqlite3";
import { book } from "../src/lib/book";
import {
  archiveBankAccount,
  createBankAccount,
  defaultForHint,
  listBankAccounts,
  renameBankAccount,
  resolveSettleCode,
  setDefaultBankAccount,
} from "../src/lib/bank-accounts";
import { createCompany } from "../src/lib/companies";
import { initSchema, seedAccountsForCompany, seedCoreData } from "../src/lib/db";
import { migrate } from "../src/lib/migrate";
import { MIGRATIONS } from "../src/lib/migrations";

const NOW = "2026-08-10T09:00:00.000Z";

/**
 * Bank/cash accounts — RVOS-006 P0a.
 *
 * Two things this table must never do: leak between companies (same worst
 * failure class as the import paths — see import-isolation.test.ts), and let
 * a book end up with no cash or bank account to resolve an ingestion hint to,
 * which would fail every future import at staging time rather than here.
 */

function twoCompanyDb(): { db: Database.Database; companyA: number; companyB: number } {
  const db = new Database(":memory:");
  initSchema(db);
  seedCoreData(db);
  migrate(db, MIGRATIONS, { now: NOW });
  const companyA = 1;
  const companyB = createCompany(db, { name: "Client B" }, NOW);
  seedAccountsForCompany(db, companyB);
  return { db, companyA, companyB };
}

test("migration 004 wraps every existing company's seeded Cash and Bank", () => {
  const { db, companyA } = twoCompanyDb();
  const rows = listBankAccounts(book(db, companyA));
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.kind).sort(), ["bank", "cash"]);
  assert.ok(rows.every((r) => r.is_default === 1));
});

test("a company onboarded AFTER migration 004 still gets bank accounts", () => {
  // seedAccountsForCompany calls seedBankAccounts itself — see db.ts's
  // docstring on why that call lives inside the seeding function rather than
  // being left to each caller.
  const { db, companyB } = twoCompanyDb();
  const rows = listBankAccounts(book(db, companyB));
  assert.equal(rows.length, 2);
});

test("createBankAccount gives the account its OWN ledger, allocated in its kind's code range", () => {
  const { db, companyA } = twoCompanyDb();
  const b = book(db, companyA);
  const id = createBankAccount(b, { name: "HDFC Current", kind: "bank" });
  const row = listBankAccounts(b).find((r) => r.id === id)!;
  assert.equal(row.account_code, "1110"); // next free ten in 1100-1199, after seeded 1100
  const ledger = b.get("SELECT name FROM accounts WHERE code = @code AND company_id = @company_id", {
    code: row.account_code,
  }) as { name: string };
  assert.equal(ledger.name, "HDFC Current");
});

test("first account of a kind is its default even if not asked to be", () => {
  const { db, companyA } = twoCompanyDb();
  const b = book(db, companyA);
  const id = createBankAccount(b, { name: "PhonePe", kind: "wallet" });
  const row = listBankAccounts(b).find((r) => r.id === id)!;
  assert.equal(row.is_default, 1);
});

test("a new default of a kind clears the old one — never two defaults", () => {
  const { db, companyA } = twoCompanyDb();
  const b = book(db, companyA);
  const second = createBankAccount(b, { name: "ICICI Current", kind: "bank" });
  setDefaultBankAccount(b, second);
  const defaults = listBankAccounts(b).filter((r) => r.kind === "bank" && r.is_default === 1);
  assert.equal(defaults.length, 1);
  assert.equal(defaults[0].id, second);
});

test("renaming a bank account renames its ledger too — they are one thing", () => {
  const { db, companyA } = twoCompanyDb();
  const b = book(db, companyA);
  const id = listBankAccounts(b).find((r) => r.kind === "bank")!.id;
  renameBankAccount(b, id, "State Bank Current");
  const ledger = b.get(
    `SELECT a.name FROM accounts a JOIN bank_accounts ba
       ON ba.account_id = a.id AND ba.company_id = @company_id
     WHERE ba.id = @id AND a.company_id = @company_id`,
    { id }
  ) as { name: string };
  assert.equal(ledger.name, "State Bank Current");
});

test("archiving the LAST account of a kind is refused — a future import would have nowhere to resolve to", () => {
  const { db, companyA } = twoCompanyDb();
  const b = book(db, companyA);
  const cashId = listBankAccounts(b).find((r) => r.kind === "cash")!.id;
  assert.throws(() => archiveBankAccount(b, cashId, NOW), /only.*cash account/);
});

test("archiving a non-last account hands the default to a sibling", () => {
  const { db, companyA } = twoCompanyDb();
  const b = book(db, companyA);
  const original = listBankAccounts(b).find((r) => r.kind === "bank")!;
  const second = createBankAccount(b, { name: "ICICI Current", kind: "bank" });
  archiveBankAccount(b, original.id, NOW);
  const bankRows = listBankAccounts(b, { includeArchived: true }).filter(
    (r) => r.kind === "bank"
  );
  const survivor = bankRows.find((r) => r.id === second)!;
  assert.equal(survivor.is_default, 1);
  assert.equal(bankRows.find((r) => r.id === original.id)!.archived_at, NOW);
});

test("resolveSettleCode refuses an archived account rather than posting through a closed ledger", () => {
  const { db, companyA } = twoCompanyDb();
  const b = book(db, companyA);
  const bank = listBankAccounts(b).find((r) => r.kind === "bank")!;
  createBankAccount(b, { name: "ICICI Current", kind: "bank" }); // sibling, so archiving is legal
  archiveBankAccount(b, bank.id, NOW);
  assert.throws(() => resolveSettleCode(b, bank.id), /archived/);
});

test("a normally-seeded book resolves both real hints without throwing", () => {
  const { db, companyA } = twoCompanyDb();
  const b = book(db, companyA);
  assert.doesNotThrow(() => defaultForHint(b, "cash"));
  assert.doesNotThrow(() => defaultForHint(b, "bank"));
});

test("defaultForHint throws an actionable message when a book has no cash account at all", () => {
  // archiveBankAccount refuses to remove the last account of a kind (see the
  // test above), so this state cannot arise through the app's own API — it
  // is reached here only to prove the function's OWN guard, for a company
  // whose bank_accounts row went missing some other way (a hand-rolled
  // migration on someone else's fork, a botched restore).
  const { db, companyA } = twoCompanyDb();
  db.prepare("DELETE FROM bank_accounts WHERE company_id = ? AND kind = 'cash'").run(companyA);
  const b = book(db, companyA);
  assert.throws(() => defaultForHint(b, "cash"), /has no cash account/);
});

test("company isolation: A's accounts are invisible to B, and a cross-company id resolves to nothing", () => {
  const { db, companyA, companyB } = twoCompanyDb();
  const a = book(db, companyA);
  const bBook = book(db, companyB);

  const aOnlyAccount = createBankAccount(a, { name: "A's secret account", kind: "wallet" });

  assert.ok(!listBankAccounts(bBook).some((r) => r.id === aOnlyAccount));
  assert.equal(getBankAccountAcrossCompanies(bBook, aOnlyAccount), undefined);
  assert.throws(() => resolveSettleCode(bBook, aOnlyAccount), /does not exist in this book/);
});

function getBankAccountAcrossCompanies(b: ReturnType<typeof book>, id: number) {
  return b
    .all("SELECT id FROM bank_accounts WHERE company_id = @company_id AND id = @id", { id })
    .at(0);
}
