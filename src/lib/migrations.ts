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

export const MIGRATIONS: Migration[] = [companies, sessionCompany, dropSettings];
