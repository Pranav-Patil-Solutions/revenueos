import { strict as assert } from "node:assert";
import { test } from "node:test";
import Database from "better-sqlite3";
import { initSchema, seedAccountsForCompany, seedCoreData } from "../src/lib/db";
import { migrate } from "../src/lib/migrate";
import { MIGRATIONS } from "../src/lib/migrations";
import { createCompany } from "../src/lib/companies";
import { book } from "../src/lib/book";
import { stageExcelImport } from "../src/lib/import-csv";
import { finalizeTallyImport, parseDayBook } from "../src/lib/import-tally";

/**
 * Import isolation — RVOS-004 P4.
 *
 * The spec calls this out by name: "an import that silently posts into the
 * wrong client's books is the worst failure this app can have." Both import
 * paths (CSV template and Tally Day Book) now write exclusively through a
 * `Book`, which is scoped to one company at construction — there is no
 * company id parameter either path could get wrong. These tests prove that
 * in practice: seed TWO companies with their own data, run each import
 * against ONE of them, and assert the other company's tables never move.
 */

const NOW = "2026-08-05T09:00:00.000Z";

interface TwoCompanies {
  db: Database.Database;
  companyA: number;
  companyB: number;
  partyA: number;
  partyB: number;
}

function twoCompanyDb(): TwoCompanies {
  const db = new Database(":memory:");
  initSchema(db);
  seedCoreData(db); // company 1, with its own seeded chart of accounts
  migrate(db, MIGRATIONS, { now: NOW });
  const companyA = 1;
  const companyB = createCompany(db, { name: "Client B" }, NOW);
  seedAccountsForCompany(db, companyB);

  const partyA = db
    .prepare(
      `INSERT INTO parties (company_id, name, kind, gstin, state_code, phone, created_at)
       VALUES (@company_id, 'Party A', 'customer', '', '', '', @now)`
    )
    .run({ company_id: companyA, now: NOW }).lastInsertRowid as number;
  const partyB = db
    .prepare(
      `INSERT INTO parties (company_id, name, kind, gstin, state_code, phone, created_at)
       VALUES (@company_id, 'Party B', 'customer', '', '', '', @now)`
    )
    .run({ company_id: companyB, now: NOW }).lastInsertRowid as number;

  return { db, companyA, companyB, partyA, partyB };
}

function documentsFor(db: Database.Database, companyId: number): { id: number }[] {
  return db
    .prepare("SELECT id FROM documents WHERE company_id = @company_id")
    .all({ company_id: companyId }) as { id: number }[];
}

test("stageExcelImport (CSV) lands only in the Book's own company", () => {
  const { db, companyA, companyB, partyA, partyB } = twoCompanyDb();
  const bookA = book(db, companyA);
  const bookB = book(db, companyB);

  // Company A already has a document before B ever imports anything — proves
  // the isolation holds in both directions, not just "the new row has SOME
  // company_id".
  stageExcelImport(bookA, {
    partyId: partyA,
    rows: [
      {
        row_no: 1,
        entry_date: "2026-08-01",
        particulars: "A's own row",
        ref_no: "",
        debit_paise: 100_00,
        credit_paise: null,
        entry_type: "sale",
        gst_rate: null,
        settle_account: "cash",
        party_id: null,
        confidence: 1,
        include: true,
        reason: "",
      },
    ],
    imagePath: "data/uploads/a.csv",
    sha256: "sha-a",
    now: NOW,
  });

  stageExcelImport(bookB, {
    partyId: partyB,
    rows: [
      {
        row_no: 1,
        entry_date: "2026-08-02",
        particulars: "B's own row",
        ref_no: "",
        debit_paise: 200_00,
        credit_paise: null,
        entry_type: "sale",
        gst_rate: null,
        settle_account: "cash",
        party_id: null,
        confidence: 1,
        include: true,
        reason: "",
      },
    ],
    imagePath: "data/uploads/b.csv",
    sha256: "sha-b",
    now: NOW,
  });

  const docsA = documentsFor(db, companyA);
  const docsB = documentsFor(db, companyB);
  assert.equal(docsA.length, 1, "company A sees only its own document");
  assert.equal(docsB.length, 1, "company B sees only its own document");

  const rowsA = db
    .prepare("SELECT particulars FROM staged_rows WHERE company_id = @company_id")
    .all({ company_id: companyA }) as { particulars: string }[];
  const rowsB = db
    .prepare("SELECT particulars FROM staged_rows WHERE company_id = @company_id")
    .all({ company_id: companyB }) as { particulars: string }[];
  assert.deepEqual(rowsA.map((r) => r.particulars), ["A's own row"]);
  assert.deepEqual(rowsB.map((r) => r.particulars), ["B's own row"]);

  // bookA's own guard is part of the safety net too: it cannot even be asked
  // to read company B's document by id.
  assert.equal(
    bookA.get("SELECT id FROM documents WHERE id = @id AND company_id = @company_id", {
      id: docsB[0].id,
    }),
    undefined,
    "company A's Book cannot see company B's document even by exact id"
  );
});

test("finalizeTallyImport lands only in the Book's own company, including the ledger mapping", () => {
  const { db, companyA, companyB, partyB } = twoCompanyDb();
  const bookA = book(db, companyA);
  const bookB = book(db, companyB);

  const dayBookXml = `<ENVELOPE><BODY><IMPORTDATA><REQUESTDATA><TALLYMESSAGE>
   <VOUCHER VCHTYPE="Receipt"><DATE>20260801</DATE><VOUCHERTYPENAME>Receipt</VOUCHERTYPENAME>
    <VOUCHERNUMBER>R-1</VOUCHERNUMBER><NARRATION>Isolation test</NARRATION>
    <ALLLEDGERENTRIES.LIST><LEDGERNAME>Bank</LEDGERNAME><AMOUNT>-1000.00</AMOUNT></ALLLEDGERENTRIES.LIST>
    <ALLLEDGERENTRIES.LIST><LEDGERNAME>Test Party</LEDGERNAME><AMOUNT>1000.00</AMOUNT></ALLLEDGERENTRIES.LIST>
   </VOUCHER>
  </TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;
  const vouchers = parseDayBook(dayBookXml);
  assert.equal(vouchers.length, 1);

  const bankAccountId = (
    db
      .prepare("SELECT id FROM accounts WHERE company_id = @company_id AND code = '1100'")
      .get({ company_id: companyB }) as { id: number }
  ).id;

  finalizeTallyImport(bookB, {
    partyId: partyB,
    mappings: [
      { ledger_name: "Bank", target_kind: "account", account_id: bankAccountId, party_id: null },
      { ledger_name: "Test Party", target_kind: "party", account_id: null, party_id: partyB },
    ],
    vouchers,
    taxInclusive: false,
    imagePath: "data/uploads/daybook.xml",
    sha256: "sha-daybook",
    now: NOW,
  });

  // The mapping itself must land in company B only.
  const mappingsA = db
    .prepare("SELECT ledger_name FROM ledger_mappings WHERE company_id = @company_id")
    .all({ company_id: companyA }) as { ledger_name: string }[];
  const mappingsB = db
    .prepare("SELECT ledger_name FROM ledger_mappings WHERE company_id = @company_id")
    .all({ company_id: companyB }) as { ledger_name: string }[];
  assert.deepEqual(mappingsA, [], "company A has no ledger mappings from B's import");
  assert.equal(mappingsB.length, 2);

  assert.equal(documentsFor(db, companyA).length, 0, "company A has no document from B's import");
  assert.equal(documentsFor(db, companyB).length, 1);

  assert.equal(
    bookA.get(
      "SELECT id FROM ledger_mappings WHERE ledger_name = @ledger_name AND company_id = @company_id",
      { ledger_name: "Bank" }
    ),
    undefined,
    "company A's Book cannot see company B's 'Bank' mapping even by exact name"
  );
});
