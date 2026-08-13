import type Database from "better-sqlite3";
import type { Migration } from "./migrate";

/**
 * The migration list — RVOS-004.
 *
 * Append only. Never renumber, never edit a migration that has shipped: the
 * office's database records which versions it has applied, and rewriting
 * history here means their schema and this file disagree with no way to tell.
 */

/** Tables that gain `company_id` by ALTER (no constraint changes). */
const ADD_COLUMN_TABLES = [
  "parties",
  "documents",
  "staged_rows",
  "journals",
  "journal_lines",
  "tds_entries",
  "tds_challans",
  "it_adjustments",
  "tax_payments",
  "fixed_assets",
] as const;

/**
 * 001 — one company becomes many.
 *
 * `settings` was a singleton (`CHECK (id = 1)`) and becomes `companies`, one
 * row per client business. Every book-bearing table gains `company_id`, and
 * the four tables whose UNIQUE constraints assumed a single book are rebuilt
 * so those constraints are per-company instead.
 *
 * The existing book becomes company 1, keeping its id so every foreign key,
 * report and backup taken before this migration still lines up afterwards.
 *
 * Note on foreign keys: SQLite will not let `ALTER TABLE ... ADD COLUMN` carry
 * a REFERENCES clause alongside a non-NULL default, so the ten ALTERed tables
 * get a bare `company_id`. The four rebuilt ones reference `companies(id)`
 * properly. The asymmetry is deliberate and harmless in practice — the app
 * archives companies and never deletes them, so the constraint would never
 * fire. Do not "fix" it by making companies deletable.
 */
const companies: Migration = {
  version: 1,
  name: "companies: one book becomes many",
  up: (db: Database.Database) => {
    // ── the companies table, carrying every per-book field settings held ──
    db.exec(`
      CREATE TABLE companies (
        id                   INTEGER PRIMARY KEY,
        name                 TEXT NOT NULL,
        company_name         TEXT NOT NULL DEFAULT 'My Company',
        gstin                TEXT NOT NULL DEFAULT '',
        state_code           TEXT NOT NULL DEFAULT '27',
        country              TEXT NOT NULL DEFAULT 'IN',
        currency             TEXT NOT NULL DEFAULT 'INR',
        default_gst_rate     INTEGER NOT NULL DEFAULT 18,
        tax_inclusive        INTEGER NOT NULL DEFAULT 1,
        entity_type          TEXT NOT NULL DEFAULT 'proprietorship',
        pan                  TEXT NOT NULL DEFAULT '',
        tan                  TEXT NOT NULL DEFAULT '',
        it_regime            TEXT NOT NULL DEFAULT 'new',
        presumptive          TEXT NOT NULL DEFAULT '',
        books_locked_through TEXT NOT NULL DEFAULT '',
        fy_audit_case        INTEGER NOT NULL DEFAULT 0,
        created_at           TEXT NOT NULL DEFAULT '',
        -- Archived, never deleted. Deleting a client's books is not an action
        -- this app will expose behind a button.
        archived_at          TEXT
      );
    `);

    // Carry the existing single book across, id and all. Columns are read from
    // the LIVE table rather than assumed: `settings` grew several fields via
    // ensureColumn across RVOS-002/003, so a hardcoded column list would
    // silently drop whichever this database happens to have.
    const settingsCols = (
      db.prepare("PRAGMA table_info(settings)").all() as { name: string }[]
    ).map((c) => c.name);
    const carried = settingsCols.filter((c) => c !== "id");
    const existing = db.prepare("SELECT * FROM settings WHERE id = 1").get() as
      | Record<string, unknown>
      | undefined;

    if (existing) {
      const cols = ["id", "name", ...carried];
      db.prepare(
        `INSERT INTO companies (${cols.join(", ")})
         VALUES (${cols.map((c) => `@${c}`).join(", ")})`
      ).run({
        id: 1,
        name: String(existing.company_name ?? "My Company"),
        ...Object.fromEntries(carried.map((c) => [c, existing[c] ?? null])),
      });
    }

    // ── the simple ones: a column, defaulted to the book that already exists ──
    for (const table of ADD_COLUMN_TABLES) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN company_id INTEGER NOT NULL DEFAULT 1`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_${table}_company ON ${table}(company_id)`);
    }

    // ── the four whose UNIQUE constraints assumed one book ──
    // Rebuild-copy-drop-rename. The engine has foreign keys off for this and
    // runs foreign_key_check before committing.

    db.exec(`
      CREATE TABLE accounts_new (
        id         INTEGER PRIMARY KEY,
        company_id INTEGER NOT NULL DEFAULT 1 REFERENCES companies(id),
        code       TEXT NOT NULL,
        name       TEXT NOT NULL,
        type       TEXT NOT NULL CHECK (type IN ('asset','liability','equity','income','expense')),
        group_code TEXT,
        UNIQUE (company_id, code)
      );
      INSERT INTO accounts_new (id, company_id, code, name, type, group_code)
        SELECT id, 1, code, name, type, group_code FROM accounts;
      DROP TABLE accounts;
      ALTER TABLE accounts_new RENAME TO accounts;
      CREATE INDEX IF NOT EXISTS idx_accounts_company ON accounts(company_id);
    `);

    db.exec(`
      CREATE TABLE ledger_mappings_new (
        id          INTEGER PRIMARY KEY,
        company_id  INTEGER NOT NULL DEFAULT 1 REFERENCES companies(id),
        ledger_name TEXT NOT NULL,
        target_kind TEXT NOT NULL CHECK (target_kind IN ('account','party')),
        account_id  INTEGER REFERENCES accounts(id),
        party_id    INTEGER REFERENCES parties(id),
        created_at  TEXT NOT NULL,
        CHECK ((target_kind = 'account') = (account_id IS NOT NULL)),
        CHECK ((target_kind = 'party')   = (party_id   IS NOT NULL)),
        UNIQUE (company_id, ledger_name)
      );
      INSERT INTO ledger_mappings_new
        (id, company_id, ledger_name, target_kind, account_id, party_id, created_at)
        SELECT id, 1, ledger_name, target_kind, account_id, party_id, created_at
          FROM ledger_mappings;
      DROP TABLE ledger_mappings;
      ALTER TABLE ledger_mappings_new RENAME TO ledger_mappings;
    `);

    db.exec(`
      CREATE TABLE compliance_marks_new (
        id         INTEGER PRIMARY KEY,
        company_id INTEGER NOT NULL DEFAULT 1 REFERENCES companies(id),
        rule_code  TEXT NOT NULL,
        period     TEXT NOT NULL,
        status     TEXT NOT NULL CHECK (status IN ('done','na')),
        marked_at  TEXT NOT NULL,
        note       TEXT NOT NULL DEFAULT '',
        UNIQUE (company_id, rule_code, period)
      );
      INSERT INTO compliance_marks_new
        (id, company_id, rule_code, period, status, marked_at, note)
        SELECT id, 1, rule_code, period, status, marked_at, note FROM compliance_marks;
      DROP TABLE compliance_marks;
      ALTER TABLE compliance_marks_new RENAME TO compliance_marks;
    `);

    db.exec(`
      CREATE TABLE wdv_openings_new (
        id            INTEGER PRIMARY KEY,
        company_id    INTEGER NOT NULL DEFAULT 1 REFERENCES companies(id),
        fy            TEXT NOT NULL,
        block         TEXT NOT NULL CHECK (block IN
                      ('building','furniture','plant','vehicles','computers')),
        opening_paise INTEGER NOT NULL CHECK (opening_paise >= 0),
        created_at    TEXT NOT NULL,
        UNIQUE (company_id, fy, block)
      );
      INSERT INTO wdv_openings_new (id, company_id, fy, block, opening_paise, created_at)
        SELECT id, 1, fy, block, opening_paise, created_at FROM wdv_openings;
      DROP TABLE wdv_openings;
      ALTER TABLE wdv_openings_new RENAME TO wdv_openings;
    `);

    // `settings` is kept, not dropped. Every reader still points at it until
    // P2 ports them onto the Book handle; dropping it here would break the app
    // between two commits on the same branch. A later migration removes it
    // once nothing reads it.
  },
};

/**
 * 002 — a session may carry the chosen company.
 *
 * Nullable and no default: a session minted before this migration, or a fresh
 * login, has chosen nothing yet — that IS "no company selected", not an error
 * state. `auth_sessions` is a GLOBAL table (firm staff, not client data), so
 * this column means something different from company_id everywhere else in
 * the schema: it names which book a login is currently looking at, not who
 * owns the row.
 */
const sessionCompany: Migration = {
  version: 2,
  name: "auth_sessions: a session may carry the chosen company",
  up: (db: Database.Database) => {
    db.exec(`ALTER TABLE auth_sessions ADD COLUMN company_id INTEGER REFERENCES companies(id)`);
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_auth_sessions_company ON auth_sessions(company_id)`
    );
  },
};

/**
 * 003 — drop the retired `settings` singleton.
 *
 * RVOS-004 P6 finished porting every reader/writer onto `companies` (see
 * `getCompany`/`updateCompanySettings` in companies.ts). Migration 001 kept
 * `settings` around only so the app kept working mid-branch between commits;
 * that reason is gone now. Dropping it turns "a query still points at the
 * frozen company-1 table" from a silent staleness bug into a loud SQL error
 * on the next boot, which is the failure mode this app always prefers.
 */
const dropSettings: Migration = {
  version: 3,
  name: "settings: drop the retired singleton",
  up: (db: Database.Database) => {
    db.exec(`DROP TABLE IF EXISTS settings;`);
  },
};

/**
 * 004 — one "Bank" becomes many real accounts (RVOS-006 P0a).
 *
 * `staged_rows.settle_account` was `TEXT CHECK (settle_account IN
 * ('cash','bank'))`, and `posting.ts` mapped those two values to exactly two
 * ledger codes. An office with a current account, an OD account and a UPI
 * wallet had nowhere to put them: every bank movement collapsed onto ledger
 * 1100, which makes reconciliation against a real bank statement impossible
 * and shows one figure on the balance sheet where there are three.
 *
 * So: a `bank_accounts` table, each row owning its OWN chart-of-accounts
 * ledger, and `staged_rows` carries a `bank_account_id` instead of the enum.
 *
 * Note on the enum's lifecycle: `initSchema`'s frozen DDL still creates
 * `settle_account` on a brand-new database, and this migration then rebuilds
 * it away — the same shape migration 003 has with `settings`, which the DDL
 * also still creates. Editing the DDL instead would leave a fresh database and
 * an existing one with different column sets for this migration to reconcile,
 * which is strictly worse than one redundant column for the length of one boot.
 *
 * The seeded Cash (1000) and Bank (1100) ledgers are REUSED rather than
 * replaced, so every journal, report, export and backup taken before this
 * migration still lines up afterwards.
 */
const bankAccounts: Migration = {
  version: 4,
  name: "bank_accounts: one 'Bank' becomes many real accounts",
  up: (db: Database.Database) => {
    db.exec(`
      CREATE TABLE bank_accounts (
        id         INTEGER PRIMARY KEY,
        company_id INTEGER NOT NULL REFERENCES companies(id),
        name       TEXT NOT NULL,
        -- 'wallet' and 'card' exist because an office really holds them, but
        -- they are never inferred from a document: nothing upstream can tell a
        -- wallet movement from a bank one, so a human picks them or nothing
        -- does (see bank-accounts.ts on the hint seam).
        kind       TEXT NOT NULL CHECK (kind IN ('bank','cash','wallet','card')),
        -- Its own ledger. Two accounts sharing one ledger could not be
        -- reconciled separately, which is the entire point of this migration.
        account_id INTEGER NOT NULL REFERENCES accounts(id),
        account_no TEXT NOT NULL DEFAULT '',
        ifsc       TEXT NOT NULL DEFAULT '',
        is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0,1)),
        archived_at TEXT,
        created_at TEXT NOT NULL,
        UNIQUE (company_id, account_id)
      );
      CREATE INDEX idx_bank_accounts_company ON bank_accounts(company_id);
      -- At most one default per kind per book. A partial index, so archived and
      -- non-default rows are unconstrained.
      CREATE UNIQUE INDEX idx_bank_accounts_default
        ON bank_accounts(company_id, kind) WHERE is_default = 1;
    `);

    // ── every existing book gets its Cash and Bank ledgers wrapped ──
    const companyRows = db.prepare("SELECT id FROM companies ORDER BY id").all() as {
      id: number;
    }[];
    const findAccount = db.prepare(
      "SELECT id FROM accounts WHERE company_id = @companyId AND code = @code"
    );
    const insertAccount = db.prepare(
      `INSERT INTO accounts (company_id, code, name, type, group_code)
       VALUES (@companyId, @code, @name, 'asset', 'current_assets')`
    );
    const insertBankAccount = db.prepare(
      `INSERT INTO bank_accounts
         (company_id, name, kind, account_id, is_default, created_at)
       VALUES (@companyId, @name, @kind, @accountId, 1, @now)`
    );
    const now = new Date().toISOString();

    for (const { id: companyId } of companyRows) {
      for (const seed of [
        { code: "1000", name: "Cash", kind: "cash" },
        { code: "1100", name: "Bank", kind: "bank" },
      ]) {
        // Created if absent rather than assumed: this migration must be total
        // for every company in the file, and a book missing 1000/1100 would
        // otherwise fail the NOT NULL backfill below with a far less obvious
        // error than "your chart of accounts is incomplete".
        let account = findAccount.get({ companyId, code: seed.code }) as
          | { id: number }
          | undefined;
        if (!account) {
          const inserted = insertAccount.run({
            companyId,
            code: seed.code,
            name: seed.name,
          });
          account = { id: Number(inserted.lastInsertRowid) };
        }
        insertBankAccount.run({
          companyId,
          name: seed.name,
          kind: seed.kind,
          accountId: account.id,
          now,
        });
      }
    }

    // ── staged_rows: the enum becomes a reference ──
    // Rebuild-copy-drop-rename, the same procedure migration 001 used. The
    // engine has foreign keys off for this and runs foreign_key_check before
    // committing.
    db.exec(`
      CREATE TABLE staged_rows_new (
        id                INTEGER PRIMARY KEY,
        company_id        INTEGER NOT NULL DEFAULT 1 REFERENCES companies(id),
        document_id       INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        row_no            INTEGER NOT NULL,
        entry_date        TEXT,
        particulars       TEXT NOT NULL DEFAULT '',
        ref_no            TEXT NOT NULL DEFAULT '',
        debit_paise       INTEGER,
        credit_paise      INTEGER,
        entry_type        TEXT NOT NULL CHECK (entry_type IN
                          ('sale','receipt','purchase','payment','credit_note','debit_note','opening','other')),
        gst_rate          INTEGER,
        -- Was: settle_account TEXT CHECK (... IN ('cash','bank')).
        bank_account_id   INTEGER NOT NULL REFERENCES bank_accounts(id),
        confidence        REAL NOT NULL DEFAULT 0,
        is_balance_row    INTEGER NOT NULL DEFAULT 0,
        include           INTEGER NOT NULL DEFAULT 1,
        posted_journal_id INTEGER,
        party_id          INTEGER REFERENCES parties(id)
      );

      INSERT INTO staged_rows_new
        (id, company_id, document_id, row_no, entry_date, particulars, ref_no,
         debit_paise, credit_paise, entry_type, gst_rate, bank_account_id,
         confidence, is_balance_row, include, posted_journal_id, party_id)
      SELECT s.id, s.company_id, s.document_id, s.row_no, s.entry_date, s.particulars,
             s.ref_no, s.debit_paise, s.credit_paise, s.entry_type, s.gst_rate,
             -- The old enum's two values map to the book's default account of
             -- that kind. NOT NULL is deliberate: a row that cannot be mapped
             -- rolls the whole migration back rather than posting money
             -- through an account nobody chose.
             (SELECT ba.id FROM bank_accounts ba
               WHERE ba.company_id = s.company_id
                 AND ba.kind = CASE WHEN s.settle_account = 'bank' THEN 'bank' ELSE 'cash' END
               ORDER BY ba.is_default DESC, ba.id LIMIT 1),
             s.confidence, s.is_balance_row, s.include, s.posted_journal_id, s.party_id
        FROM staged_rows s;

      DROP TABLE staged_rows;
      ALTER TABLE staged_rows_new RENAME TO staged_rows;
      CREATE INDEX idx_staged_document ON staged_rows(document_id);
      CREATE INDEX idx_staged_rows_company ON staged_rows(company_id);
      CREATE INDEX idx_staged_rows_bank_account ON staged_rows(bank_account_id);
    `);
  },
};

/**
 * 005 — who did it, and what they may do (RVOS-006 P0b).
 *
 * Until now `journals` recorded WHEN an entry was posted and never WHO, and
 * `auth_users` had no role: every person who could sign in could do everything
 * — post to any client's books, lock a year, change a company's tax identity —
 * and afterwards nothing recorded which of them had. For a firm with staff on
 * shared client books that is the control gap, not a missing convenience.
 *
 * Three parts:
 *
 * 1. `journals.created_by` — nullable, and NULL is a real, honest state: every
 *    journal posted before this migration has no recorded author, and guessing
 *    one (the only user, the company owner) would be fabricating an audit
 *    trail. Reports must render NULL as "unknown", never as a name.
 *
 * 2. `auth_users.role` — existing users default to `owner`. That is deliberate
 *    and is the safe direction: before this migration nobody's authority WAS
 *    restricted, so demoting the office's existing logins would silently take
 *    away access they already rely on, and on a single-user install it would
 *    lock them out of their own books. New users get a role chosen explicitly.
 *
 * 3. `audit_log` — append-only, enforced by TRIGGERS rather than by convention.
 *    An audit trail that the application can quietly rewrite is not evidence of
 *    anything, so UPDATE and DELETE on it raise at the SQL level; the app has
 *    no code path that edits history, and now it cannot grow one by accident.
 *
 * No FK on `created_by`: SQLite's ALTER TABLE ADD COLUMN cannot carry a
 * REFERENCES clause, the same documented asymmetry migration 001 has on its
 * ten ALTERed tables. Users are never deleted (sessions are), so it would
 * never fire.
 */
const attributionAndRoles: Migration = {
  version: 5,
  name: "attribution: journals.created_by, auth_users.role, audit_log",
  up: (db: Database.Database) => {
    db.exec(`ALTER TABLE journals ADD COLUMN created_by INTEGER`);
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_journals_created_by ON journals(created_by)`
    );

    db.exec(
      `ALTER TABLE auth_users ADD COLUMN role TEXT NOT NULL DEFAULT 'owner'
         CHECK (role IN ('owner','accountant','clerk','viewer'))`
    );

    db.exec(`
      CREATE TABLE audit_log (
        id            INTEGER PRIMARY KEY,
        company_id    INTEGER NOT NULL REFERENCES companies(id),
        -- NULL only for an action with no signed-in actor (a migration, a CLI
        -- script). A user action must always name its user.
        actor_user_id INTEGER REFERENCES auth_users(id),
        -- Dotted, stable, machine-readable: 'journal.post', 'books.lock'.
        action        TEXT NOT NULL,
        entity        TEXT NOT NULL,
        entity_id     INTEGER,
        -- One sentence a non-programmer can read in the log.
        summary       TEXT NOT NULL,
        -- JSON snapshots. before is NULL on create, after is NULL on delete;
        -- both present on a change.
        before_json   TEXT,
        after_json    TEXT,
        created_at    TEXT NOT NULL
      );
      CREATE INDEX idx_audit_log_company ON audit_log(company_id, created_at);
      CREATE INDEX idx_audit_log_entity ON audit_log(company_id, entity, entity_id);

      -- Append-only, structurally. See this migration's docstring.
      CREATE TRIGGER audit_log_is_append_only_update
        BEFORE UPDATE ON audit_log
      BEGIN
        SELECT RAISE(ABORT, 'audit_log is append-only: an audit trail the app can rewrite is not evidence');
      END;
      CREATE TRIGGER audit_log_is_append_only_delete
        BEFORE DELETE ON audit_log
      BEGIN
        SELECT RAISE(ABORT, 'audit_log is append-only: an audit trail the app can erase is not evidence');
      END;
    `);
  },
};

/**
 * 006 — cost centres (RVOS-006 P0c).
 *
 * The books can say WHAT was earned and spent and WHO it was with. They cannot
 * say WHICH PART OF THE BUSINESS did it: one P&L for a firm running two shops,
 * three sites or a service arm beside a trading arm answers none of the
 * questions an owner actually asks. That dimension is the thing budgets
 * (Stage 4 P15) are sliced by, so it has to exist before the phases that write
 * journals, not after.
 *
 * Why now, with nothing yet using it: this adds a column to `journal_lines`
 * that every later phase writes. There are TWO posting paths today
 * (`postDocument`, `postManualVoucher`/`postVoucherWithTds`); after orders,
 * disposal and payroll there will be five. Threading a dimension through two
 * paths costs a day, through five it costs a week and gets missed in one.
 *
 * Three deliberate choices:
 *
 * 1. **Nullable, and NULL is the normal case.** Most lines have no cost centre
 *    and never will — a bank leg, a GST leg, a control-account leg. A NOT NULL
 *    column with an "Unallocated" sentinel row would force every book to carry
 *    a fiction and every report to special-case it.
 *
 * 2. **On the LINE, not the journal.** One purchase can split across two sites;
 *    a journal-level column could not express that without a second journal,
 *    which would misstate the document trail to satisfy a reporting dimension.
 *
 * 3. **`staged_rows` gets it too.** Otherwise the document path — the app's
 *    primary way of getting entries into the books — could never set one, and
 *    "threaded through both posting paths" would be true only on paper.
 *
 * No FK on either ALTERed column: SQLite's ALTER TABLE ADD COLUMN cannot carry
 * a REFERENCES clause, the same documented asymmetry migrations 001 and 005
 * carry. Cost centres are archived, never deleted (the house rule), so a
 * dangling id cannot arise from this app.
 */
const costCentres: Migration = {
  version: 6,
  name: "cost_centres: which part of the business earned or spent it",
  up: (db: Database.Database) => {
    db.exec(`
      CREATE TABLE cost_centres (
        id          INTEGER PRIMARY KEY,
        company_id  INTEGER NOT NULL REFERENCES companies(id),
        -- Short and stable: what a budget line, an MIS column header and a CSV
        -- export are keyed by. The name can be re-worded; the code should not.
        code        TEXT NOT NULL,
        name        TEXT NOT NULL,
        -- Archive, never delete — journals already point at it.
        archived_at TEXT,
        created_at  TEXT NOT NULL,
        UNIQUE (company_id, code)
      );
      CREATE INDEX idx_cost_centres_company ON cost_centres(company_id);
    `);

    db.exec(`ALTER TABLE journal_lines ADD COLUMN cost_centre_id INTEGER`);
    // Partial: the great majority of lines carry no cost centre, and an index
    // over those NULLs would be mostly dead weight on every insert.
    db.exec(`
      CREATE INDEX idx_journal_lines_cost_centre
        ON journal_lines(company_id, cost_centre_id)
        WHERE cost_centre_id IS NOT NULL
    `);

    db.exec(`ALTER TABLE staged_rows ADD COLUMN cost_centre_id INTEGER`);
  },
};

export const MIGRATIONS: Migration[] = [
  companies,
  sessionCompany,
  dropSettings,
  bankAccounts,
  attributionAndRoles,
  costCentres,
];
