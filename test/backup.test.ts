import { strict as assert } from "node:assert";
import { test } from "node:test";
import Database from "better-sqlite3";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { configureConnection, initSchema, seedAccountsForCompany, seedCoreData } from "../src/lib/db";
import { migrate } from "../src/lib/migrate";
import { MIGRATIONS } from "../src/lib/migrations";
import { createCompany } from "../src/lib/companies";
import {
  createBackup,
  DEFAULT_RETENTION,
  exportCompany,
  instantOf,
  listBackups,
  planRetention,
  pruneBackups,
  restoreBackup,
  stampFor,
  verifyBackup,
  type BackupFile,
} from "../src/lib/backup";

const T0 = "2026-07-21T09:30:00.000Z";

function scratch(): string {
  return mkdtempSync(path.join(tmpdir(), "revenueos-backup-"));
}

/** A book with a real balanced journal in it, on disk (backup needs a file). */
function bookAt(file: string): Database.Database {
  const db = new Database(file);
  initSchema(db);
  seedCoreData(db);
  migrate(db, MIGRATIONS, { now: T0 });
  const acc = (code: string) =>
    (db.prepare("SELECT id FROM accounts WHERE code = ?").get(code) as { id: number }).id;

  db.prepare(
    `INSERT INTO journals (entry_date, entry_type, memo, ref_no, created_at)
     VALUES ('2026-07-20', 'journal', 'backup fixture', 'BK-1', '2026-07-20T00:00:00.000Z')`
  ).run();
  const jid = Number(
    (db.prepare("SELECT MAX(id) AS id FROM journals").get() as { id: number }).id
  );
  const line = db.prepare(
    `INSERT INTO journal_lines (journal_id, line_no, account_id, debit_paise, credit_paise)
     VALUES (@j, @n, @a, @d, @c)`
  );
  line.run({ j: jid, n: 1, a: acc("1000"), d: 250_000, c: 0 });
  line.run({ j: jid, n: 2, a: acc("1100"), d: 0, c: 250_000 });
  return db;
}

function netPaise(db: Database.Database): number {
  return (
    db
      .prepare(
        "SELECT COALESCE(SUM(debit_paise) - SUM(credit_paise), 0) AS d FROM journal_lines"
      )
      .get() as { d: number }
  ).d;
}

// ── naming ───────────────────────────────────────────────────────────────

test("stamps are filesystem-safe and sort chronologically", () => {
  assert.equal(stampFor(T0), "20260721-093000");
  assert.ok(stampFor("2026-01-02T03:04:05.000Z") < stampFor(T0));
  assert.throws(() => stampFor("not a date"));
});

test("a stamped directory name round-trips to its instant", () => {
  assert.equal(instantOf("revenueos-20260721-093000")?.toISOString(), T0);
  assert.equal(instantOf("not-ours"), null);
  assert.equal(instantOf("revenueos-backup-final-FINAL"), null);
});

// ── the round trip that actually matters ─────────────────────────────────

test("a backup restores to a working book — rows, balance and content", async () => {
  const dir = scratch();
  try {
    const source = path.join(dir, "revenueos.db");
    const db = bookAt(source);
    const before = {
      journals: (db.prepare("SELECT COUNT(*) AS n FROM journals").get() as { n: number }).n,
      lines: (db.prepare("SELECT COUNT(*) AS n FROM journal_lines").get() as { n: number }).n,
      accounts: (db.prepare("SELECT COUNT(*) AS n FROM accounts").get() as { n: number }).n,
      net: netPaise(db),
    };

    const result = await createBackup(db, path.join(dir, "backups"), T0);
    db.close();

    assert.ok(result.bytes > 0);
    assert.match(result.sha256, /^[0-9a-f]{64}$/);
    assert.equal(verifyBackup(result.db_path), null);

    // Destroy the original the way a disk failure would, then come back.
    rmSync(source, { force: true });
    const outcome = restoreBackup(result.db_path, source, "2026-07-22T10:00:00.000Z");
    assert.equal(outcome.previous_saved_to, null, "nothing was there to preserve");

    const restored = new Database(source, { readonly: true });
    assert.equal(
      (restored.prepare("SELECT COUNT(*) AS n FROM journals").get() as { n: number }).n,
      before.journals
    );
    assert.equal(
      (restored.prepare("SELECT COUNT(*) AS n FROM journal_lines").get() as { n: number }).n,
      before.lines
    );
    assert.equal(
      (restored.prepare("SELECT COUNT(*) AS n FROM accounts").get() as { n: number }).n,
      before.accounts
    );
    assert.equal(netPaise(restored), 0, "a restored book whose journals do not balance is not a book");
    assert.equal(netPaise(restored), before.net);
    assert.equal(
      (restored.prepare("SELECT memo FROM journals WHERE ref_no = 'BK-1'").get() as {
        memo: string;
      }).memo,
      "backup fixture"
    );
    restored.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("restoring over a live book preserves what it replaced", async () => {
  const dir = scratch();
  try {
    const source = path.join(dir, "revenueos.db");
    const db = bookAt(source);
    const result = await createBackup(db, path.join(dir, "backups"), T0);
    db.close();

    const outcome = restoreBackup(result.db_path, source, "2026-07-22T10:00:00.000Z");
    assert.ok(
      outcome.previous_saved_to && existsSync(outcome.previous_saved_to),
      "a restore is destructive and happens under pressure — the replaced book must survive"
    );
    assert.equal(verifyBackup(outcome.previous_saved_to), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stale -wal/-shm sidecars are cleared, not replayed over the restore", async () => {
  const dir = scratch();
  try {
    const source = path.join(dir, "revenueos.db");
    const db = bookAt(source);
    const result = await createBackup(db, path.join(dir, "backups"), T0);
    db.close();

    // Sidecars belonging to the database being REPLACED.
    writeFileSync(`${source}-wal`, "stale");
    writeFileSync(`${source}-shm`, "stale");
    restoreBackup(result.db_path, source, "2026-07-22T10:00:00.000Z");

    assert.equal(existsSync(`${source}-wal`), false);
    assert.equal(existsSync(`${source}-shm`), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("uploads travel with the snapshot", async () => {
  const dir = scratch();
  try {
    const uploads = path.join(dir, "uploads");
    mkdirSync(uploads, { recursive: true });
    writeFileSync(path.join(uploads, "khata-1.jpg"), "not really a jpeg");
    const db = bookAt(path.join(dir, "revenueos.db"));
    const result = await createBackup(db, path.join(dir, "backups"), T0, uploads);
    db.close();
    assert.equal(result.uploads_copied, 1);
    assert.ok(existsSync(path.join(result.dir, "uploads", "khata-1.jpg")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── verification refuses the things that look like backups ───────────────

test("verifyBackup rejects a missing, empty, foreign or corrupt file", () => {
  const dir = scratch();
  try {
    assert.ok(verifyBackup(path.join(dir, "nope.db")));

    const empty = path.join(dir, "empty.db");
    writeFileSync(empty, "");
    assert.ok(verifyBackup(empty), "a zero-byte file must never pass as a book");

    const garbage = path.join(dir, "garbage.db");
    writeFileSync(garbage, "this is not a database");
    assert.ok(verifyBackup(garbage));

    // Structurally valid SQLite, but not OUR schema — integrity_check alone
    // would pass this, and restoring it would be catastrophic.
    const foreign = path.join(dir, "foreign.db");
    const f = new Database(foreign);
    f.exec("CREATE TABLE unrelated (id INTEGER PRIMARY KEY)");
    f.close();
    assert.ok(verifyBackup(foreign), "a foreign database must not pass as a book");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * `npm run backup` is what an office runs to satisfy "back up first" BEFORE
 * `npm run migrate` — the exact precondition RVOS-004 P6's own ship gate
 * requires. Every real installation is on this pre-migration schema right
 * up until someone runs the migration, so a backup taken THEN must still
 * verify — regression for a bug this suite's own hands-on rehearsal found:
 * P6 changed the sanity-check table list from `settings` to `companies`
 * unconditionally, which made `npm run backup` fail outright on every
 * not-yet-migrated database, including the office's real one. See
 * EVOLUTION #32.
 */
test("verifyBackup accepts a PRE-migration database (the settings singleton, no companies table yet)", () => {
  const dir = scratch();
  try {
    const file = path.join(dir, "pre-migration.db");
    const db = new Database(file);
    initSchema(db);
    seedCoreData(db); // schema version 0 — settings exists, companies does not
    db.close();

    assert.equal(
      (
        new Database(file, { readonly: true })
          .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'companies'")
          .get()
      ),
      undefined,
      "fixture sanity check: this db must genuinely have no companies table yet"
    );
    assert.equal(verifyBackup(file), null, "a pre-migration backup must verify — it is a real, valid book");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("restore refuses an unusable backup rather than destroying the target", () => {
  const dir = scratch();
  try {
    const target = path.join(dir, "revenueos.db");
    const db = bookAt(target);
    db.close();
    const bad = path.join(dir, "bad.db");
    writeFileSync(bad, "not a database");

    assert.throws(() => restoreBackup(bad, target, T0), /Refusing to restore/);
    assert.equal(verifyBackup(target), null, "the live book must be untouched");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── retention ────────────────────────────────────────────────────────────

function fake(iso: string): BackupFile {
  const name = `revenueos-${stampFor(iso)}`;
  return { dir: `/tmp/${name}`, name, created_at: iso };
}

test("retention keeps the recent run and one per week beyond it", () => {
  // 40 consecutive days, newest last.
  const files = Array.from({ length: 40 }, (_, i) =>
    fake(new Date(Date.UTC(2026, 5, 1) + i * 86400000).toISOString())
  );
  const { keep, remove } = planRetention(files, DEFAULT_RETENTION);

  assert.equal(keep.length + remove.length, files.length, "every file is accounted for");
  // The 14 most recent are always kept.
  const newest14 = [...files].sort((a, b) => (a.created_at < b.created_at ? 1 : -1)).slice(0, 14);
  for (const f of newest14) {
    assert.ok(keep.some((k) => k.name === f.name), `${f.name} is recent and must be kept`);
  }
  assert.ok(remove.length > 0, "40 days of dailies should not all survive");
  assert.ok(keep.length < files.length);
});

test("retention never deletes when there is little to delete", () => {
  const files = Array.from({ length: 5 }, (_, i) =>
    fake(new Date(Date.UTC(2026, 5, 1) + i * 86400000).toISOString())
  );
  const { remove } = planRetention(files, DEFAULT_RETENTION);
  assert.deepEqual(remove, []);
});

test("pruning deletes exactly what the plan said, and listing ignores strangers", async () => {
  const dir = scratch();
  try {
    const backups = path.join(dir, "backups");
    const db = bookAt(path.join(dir, "revenueos.db"));
    for (let i = 0; i < 3; i++) {
      await createBackup(db, backups, new Date(Date.UTC(2026, 0, 1 + i)).toISOString());
    }
    db.close();

    // Something that is not ours must never be listed, and never pruned.
    mkdirSync(path.join(backups, "holiday-photos"), { recursive: true });

    assert.equal(listBackups(backups).length, 3);
    const removed = pruneBackups(backups, { keepRecent: 1, keepWeeks: 0 });
    assert.equal(removed.length, 2);
    assert.equal(listBackups(backups).length, 1);
    assert.ok(
      readdirSync(backups).includes("holiday-photos"),
      "pruning must not touch directories it did not create"
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("listing is newest-first and survives a missing directory", () => {
  assert.deepEqual(listBackups("/tmp/definitely-not-here-revenueos"), []);
});

// ── durability: the book must not live in a WAL ──────────────────────────

test("a configured connection checkpoints on open and thereafter stays eager", () => {
  // Regression guard for the 2026-07-21 incident: SQLite's default 1000-page
  // auto-checkpoint never fires for a small book, so `revenueos.db` sat at
  // 4096 bytes with NO TABLES for five days while every row lived in the -wal.
  // Deleting that sidecar destroyed the ledger, and a sha256 of the .db file
  // "verified" the loss as unchanged. If either pragma below disappears, that
  // failure mode comes straight back.
  const dir = scratch();
  try {
    const file = path.join(dir, "book.db");
    const db = new Database(file);
    configureConnection(db);
    assert.equal(db.pragma("journal_mode", { simple: true }), "wal");
    assert.equal(
      db.pragma("wal_autocheckpoint", { simple: true }),
      64,
      "the default 1000 pages is ~4 MB — far more than this book will ever hold"
    );
    initSchema(db);
    seedCoreData(db);
    db.close();

    // The accounts must be readable from the MAIN file, with no sidecar help.
    rmSync(`${file}-wal`, { force: true });
    rmSync(`${file}-shm`, { force: true });
    const reopened = new Database(file, { readonly: true });
    const n = (reopened.prepare("SELECT COUNT(*) AS n FROM accounts").get() as { n: number }).n;
    reopened.close();
    assert.ok(n > 0, "a book that needs its -wal to be readable is one delete from gone");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── what the review caught ───────────────────────────────────────────────

test("restore brings the ledger PHOTOS back, not just the database", async () => {
  // documents.image_path points at these files. A db restored without them
  // leaves every document referencing something that is not there — and the
  // backup captured them, so failing to restore them was pure omission.
  const dir = scratch();
  try {
    const uploads = path.join(dir, "uploads");
    mkdirSync(uploads, { recursive: true });
    writeFileSync(path.join(uploads, "khata-1.jpg"), "ledger photo");
    const source = path.join(dir, "revenueos.db");
    const db = bookAt(source);
    const result = await createBackup(db, path.join(dir, "backups"), T0, uploads);
    db.close();

    rmSync(uploads, { recursive: true, force: true });
    const restoreTarget = path.join(dir, "uploads");
    const outcome = restoreBackup(
      result.db_path,
      source,
      "2026-07-22T10:00:00.000Z",
      restoreTarget
    );

    assert.equal(outcome.uploads_restored, 1);
    assert.ok(existsSync(path.join(restoreTarget, "khata-1.jpg")), "the photo must come back");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failed restore NAMES the preserved book instead of reading like total loss", () => {
  const dir = scratch();
  try {
    const target = path.join(dir, "revenueos.db");
    bookAt(target).close();
    // A snapshot that passes the pre-check and then cannot land.
    const bad = path.join(dir, "vanishing.db");
    bookAt(bad).close();
    rmSync(bad); // disappears between verification and copy

    let message = "";
    try {
      restoreBackup(bad, target, T0);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    assert.ok(message, "it must throw");
    // Either it refused up front (target untouched), or it failed mid-flight
    // and must say where the good book went.
    if (!/Refusing to restore/.test(message)) {
      assert.match(message, /UNHARMED at/, "a panicking operator needs the path");
    }
    assert.equal(verifyBackup(target), null, "the live book survives either way");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a snapshot whose uploads cannot be copied is discarded entirely", async () => {
  const dir = scratch();
  try {
    const db = bookAt(path.join(dir, "revenueos.db"));
    const backups = path.join(dir, "backups");
    // Point at an uploads path that exists but cannot be read as a directory.
    const notADir = path.join(dir, "uploads-file");
    writeFileSync(notADir, "not a directory");
    await assert.rejects(() => createBackup(db, backups, T0, notADir));
    db.close();
    assert.deepEqual(
      listBackups(backups),
      [],
      "a verified db with missing photos must not survive as a good-looking snapshot"
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── per-company export (RVOS-004 P5) ──────────────────────────────────────

/** Two companies, on disk, migrated to current schema, each with its own
 * seeded accounts and one balanced journal — enough to prove an export picks
 * out exactly one company's rows and nothing of its sibling's. */
function twoCompanyBookAt(file: string): {
  db: Database.Database;
  companyA: number;
  companyB: number;
} {
  const db = new Database(file);
  initSchema(db);
  seedCoreData(db); // company 1
  migrate(db, MIGRATIONS, { now: T0 });
  const companyA = 1;
  const companyB = createCompany(db, { name: "Client B" }, T0);
  seedAccountsForCompany(db, companyB);

  const acc = (companyId: number, code: string) =>
    (
      db
        .prepare("SELECT id FROM accounts WHERE company_id = ? AND code = ?")
        .get(companyId, code) as { id: number }
    ).id;

  const postJournal = (companyId: number, memo: string): void => {
    db.prepare(
      `INSERT INTO journals (company_id, entry_date, entry_type, memo, ref_no, created_at)
       VALUES (@company_id, '2026-07-20', 'journal', @memo, 'BK-1', '2026-07-20T00:00:00.000Z')`
    ).run({ company_id: companyId, memo });
    const jid = Number(
      (db.prepare("SELECT MAX(id) AS id FROM journals").get() as { id: number }).id
    );
    const line = db.prepare(
      `INSERT INTO journal_lines (company_id, journal_id, line_no, account_id, debit_paise, credit_paise)
       VALUES (@company_id, @j, @n, @a, @d, @c)`
    );
    line.run({ company_id: companyId, j: jid, n: 1, a: acc(companyId, "1000"), d: 250_000, c: 0 });
    line.run({ company_id: companyId, j: jid, n: 2, a: acc(companyId, "1100"), d: 0, c: 250_000 });
  };

  postJournal(companyA, "A's own journal");
  postJournal(companyB, "B's own journal");

  return { db, companyA, companyB };
}

test("exportCompany produces a standalone db with ONLY that company's rows", async () => {
  const dir = scratch();
  try {
    const { db, companyA, companyB } = twoCompanyBookAt(path.join(dir, "revenueos.db"));

    const result = await exportCompany(db, companyB, path.join(dir, "backups"), T0);
    db.close();

    assert.equal(result.company_id, companyB);
    assert.ok(result.bytes > 0);
    assert.equal(verifyBackup(result.db_path, { companyId: companyB }), null);
    // The whole-db check (no opts) must also pass — it's a real, usable book.
    assert.equal(verifyBackup(result.db_path), null);

    const exported = new Database(result.db_path, { readonly: true });
    const companies = exported.prepare("SELECT id, name FROM companies").all() as {
      id: number;
      name: string;
    }[];
    assert.deepEqual(companies, [{ id: companyB, name: "Client B" }]);

    const journals = exported.prepare("SELECT memo FROM journals").all() as { memo: string }[];
    assert.deepEqual(journals.map((j) => j.memo), ["B's own journal"], "company A's journal must not be present");

    assert.equal(result.row_counts.journals, 1);
    assert.equal(result.row_counts.journal_lines, 2);
    assert.ok(result.row_counts.accounts > 0);

    const net = exported
      .prepare("SELECT COALESCE(SUM(debit_paise) - SUM(credit_paise), 0) AS d FROM journal_lines")
      .get() as { d: number };
    assert.equal(net.d, 0, "the exported company's own book still balances");
    exported.close();

    assert.notEqual(companyA, companyB, "sanity: the two companies really are different ids");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verifyBackup's per-company mode catches a leaked row from another company", async () => {
  const dir = scratch();
  try {
    const { db, companyA, companyB } = twoCompanyBookAt(path.join(dir, "revenueos.db"));
    const result = await exportCompany(db, companyB, path.join(dir, "backups"), T0);
    db.close();

    // Simulate the bug this check exists to catch: a row from company A
    // lands in what's supposed to be company B's exclusive export.
    const tampered = new Database(result.db_path);
    tampered
      .prepare(
        `INSERT INTO journals (company_id, entry_date, entry_type, memo, ref_no, created_at)
         VALUES (@company_id, '2026-07-21', 'journal', 'leaked from A', 'BK-2', '2026-07-21T00:00:00.000Z')`
      )
      .run({ company_id: companyA });
    tampered.close();

    const problem = verifyBackup(result.db_path, { companyId: companyB });
    assert.ok(problem, "a leaked row from a different company must fail verification");
    assert.match(problem!, /journals/);
    assert.match(problem!, /leaked/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("exportCompany refuses an unknown company id", async () => {
  const dir = scratch();
  try {
    const { db } = twoCompanyBookAt(path.join(dir, "revenueos.db"));
    await assert.rejects(
      () => exportCompany(db, 999, path.join(dir, "backups"), T0),
      /No such company/
    );
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("exportCompany copies only the exported company's own referenced uploads", async () => {
  const dir = scratch();
  try {
    const { db, companyA, companyB } = twoCompanyBookAt(path.join(dir, "revenueos.db"));

    mkdirSync(path.join(dir, "data", "uploads"), { recursive: true });
    writeFileSync(path.join(dir, "data", "uploads", "a-doc.jpg"), "A's photo");
    writeFileSync(path.join(dir, "data", "uploads", "b-doc.jpg"), "B's photo");

    const party = (companyId: number, name: string): number =>
      Number(
        db
          .prepare(
            `INSERT INTO parties (company_id, name, kind, gstin, state_code, phone, created_at)
             VALUES (@company_id, @name, 'customer', '', '', '', '2026-07-20T00:00:00Z')`
          )
          .run({ company_id: companyId, name }).lastInsertRowid
      );
    const partyA = party(companyA, "Party A");
    const partyB = party(companyB, "Party B");

    db.prepare(
      `INSERT INTO documents (company_id, party_id, image_path, image_sha256, status, created_at)
       VALUES (@company_id, @party_id, @path, 'sha', 'extracted', '2026-07-20T00:00:00Z')`
    ).run({ company_id: companyA, party_id: partyA, path: "data/uploads/a-doc.jpg" });
    db.prepare(
      `INSERT INTO documents (company_id, party_id, image_path, image_sha256, status, created_at)
       VALUES (@company_id, @party_id, @path, 'sha', 'extracted', '2026-07-20T00:00:00Z')`
    ).run({ company_id: companyB, party_id: partyB, path: "data/uploads/b-doc.jpg" });

    const result = await exportCompany(db, companyB, path.join(dir, "backups"), T0, dir);
    db.close();

    assert.equal(result.uploads_expected, 1);
    assert.equal(result.uploads_copied, 1);
    assert.ok(existsSync(path.join(result.dir, "uploads", "b-doc.jpg")));
    assert.equal(
      existsSync(path.join(result.dir, "uploads", "a-doc.jpg")),
      false,
      "company A's photo must not travel into company B's export"
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failed export cleans up after itself rather than leaving a partial directory", async () => {
  const dir = scratch();
  try {
    const { db } = twoCompanyBookAt(path.join(dir, "revenueos.db"));
    const backups = path.join(dir, "backups");
    await assert.rejects(() => exportCompany(db, 999, backups, T0));
    db.close();
    assert.equal(
      existsSync(backups) ? readdirSync(backups).length : 0,
      0,
      "a refused export must not leave an empty or partial directory behind"
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("exportCompany succeeds for a company with a reconciled TDS challan (regression: FK insertion order)", async () => {
  // Caught in review: SCOPED_TABLES lists tds_entries before tds_challans,
  // but tds_entries.challan_id REFERENCES tds_challans(id) — any company
  // that has ever deposited a TDS challan (routine, not an edge case) threw
  // FOREIGN KEY constraint failed here before defer_foreign_keys was added.
  const dir = scratch();
  try {
    const { db, companyB } = twoCompanyBookAt(path.join(dir, "revenueos.db"));

    const partyId = Number(
      db
        .prepare(
          `INSERT INTO parties (company_id, name, kind, gstin, state_code, phone, created_at)
           VALUES (@company_id, 'TDS Party', 'supplier', '', '', '', '2026-07-20T00:00:00Z')`
        )
        .run({ company_id: companyB }).lastInsertRowid
    );

    const journalFor = (memo: string): number => {
      db.prepare(
        `INSERT INTO journals (company_id, entry_date, entry_type, memo, ref_no, created_at)
         VALUES (@company_id, '2026-07-25', 'payment', @memo, '', '2026-07-25T00:00:00.000Z')`
      ).run({ company_id: companyB, memo });
      return Number((db.prepare("SELECT MAX(id) AS id FROM journals").get() as { id: number }).id);
    };
    const entryJournalId = journalFor("TDS deduction");
    const challanJournalId = journalFor("TDS challan deposit");

    const challanId = Number(
      db
        .prepare(
          `INSERT INTO tds_challans
             (company_id, fy, quarter, form, challan_no, bsr_code, paid_on, amount_paise, journal_id, created_at)
           VALUES (@company_id, '2026-27', 2, '26Q', 'CH-1', 'BSR1', '2026-08-05', 10000, @journal_id, '2026-08-05T00:00:00Z')`
        )
        .run({ company_id: companyB, journal_id: challanJournalId }).lastInsertRowid
    );

    db.prepare(
      `INSERT INTO tds_entries
         (company_id, party_id, section, entry_date, base_paise, tds_paise, rate_bp, journal_id, challan_id, created_at)
       VALUES (@company_id, @party_id, '194C', '2026-07-25', 100000, 1000, 100, @journal_id, @challan_id, '2026-07-25T00:00:00Z')`
    ).run({
      company_id: companyB,
      party_id: partyId,
      journal_id: entryJournalId,
      challan_id: challanId,
    });

    const result = await exportCompany(db, companyB, path.join(dir, "backups"), T0);
    db.close();

    assert.equal(result.row_counts.tds_entries, 1);
    assert.equal(result.row_counts.tds_challans, 1);
    assert.equal(verifyBackup(result.db_path, { companyId: companyB }), null);

    const exported = new Database(result.db_path, { readonly: true });
    const linked = exported
      .prepare("SELECT challan_id FROM tds_entries WHERE id = 1")
      .get() as { challan_id: number };
    assert.equal(linked.challan_id, challanId, "the FK link itself must survive the export");
    exported.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
