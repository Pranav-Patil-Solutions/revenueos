import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { migrate } from "./migrate";
import { MIGRATIONS } from "./migrations";

const DATA_DIR = path.join(process.cwd(), "data");
export const UPLOADS_DIR = path.join(DATA_DIR, "uploads");

declare global {
  // Reuse the connection across HMR reloads in dev.
  var __revenueosDb: Database.Database | undefined;
}

const DDL = `
  CREATE TABLE IF NOT EXISTS settings (
    id               INTEGER PRIMARY KEY CHECK (id = 1),
    company_name     TEXT NOT NULL DEFAULT 'My Company',
    gstin            TEXT NOT NULL DEFAULT '',
    state_code       TEXT NOT NULL DEFAULT '27',
    country          TEXT NOT NULL DEFAULT 'IN',
    currency         TEXT NOT NULL DEFAULT 'INR',
    default_gst_rate INTEGER NOT NULL DEFAULT 18,
    tax_inclusive    INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS accounts (
    id   INTEGER PRIMARY KEY,
    code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('asset','liability','equity','income','expense'))
  );

  CREATE TABLE IF NOT EXISTS parties (
    id         INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    kind       TEXT NOT NULL CHECK (kind IN ('customer','supplier')),
    gstin      TEXT NOT NULL DEFAULT '',
    state_code TEXT NOT NULL DEFAULT '',
    phone      TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS documents (
    id           INTEGER PRIMARY KEY,
    party_id     INTEGER NOT NULL REFERENCES parties(id),
    image_path   TEXT NOT NULL,
    image_sha256 TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'uploaded'
                 CHECK (status IN ('uploaded','extracting','extracted','posted','failed')),
    error        TEXT NOT NULL DEFAULT '',
    model        TEXT NOT NULL DEFAULT '',
    created_at   TEXT NOT NULL,
    extracted_at TEXT,
    posted_at    TEXT
  );

  CREATE TABLE IF NOT EXISTS staged_rows (
    id                INTEGER PRIMARY KEY,
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
    settle_account    TEXT NOT NULL DEFAULT 'cash' CHECK (settle_account IN ('cash','bank')),
    confidence        REAL NOT NULL DEFAULT 0,
    is_balance_row    INTEGER NOT NULL DEFAULT 0,
    include           INTEGER NOT NULL DEFAULT 1,
    posted_journal_id INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_staged_document ON staged_rows(document_id);

  CREATE TABLE IF NOT EXISTS journals (
    id                 INTEGER PRIMARY KEY,
    entry_date         TEXT NOT NULL,
    entry_type         TEXT NOT NULL,
    memo               TEXT NOT NULL DEFAULT '',
    ref_no             TEXT NOT NULL DEFAULT '',
    source_document_id INTEGER,
    source_row_id      INTEGER,
    created_at         TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS journal_lines (
    id           INTEGER PRIMARY KEY,
    journal_id   INTEGER NOT NULL REFERENCES journals(id) ON DELETE CASCADE,
    line_no      INTEGER NOT NULL,
    account_id   INTEGER NOT NULL REFERENCES accounts(id),
    party_id     INTEGER REFERENCES parties(id),
    debit_paise  INTEGER NOT NULL DEFAULT 0 CHECK (debit_paise >= 0),
    credit_paise INTEGER NOT NULL DEFAULT 0 CHECK (credit_paise >= 0),
    CHECK ((debit_paise = 0) <> (credit_paise = 0))
  );
  CREATE INDEX IF NOT EXISTS idx_lines_journal ON journal_lines(journal_id);
  CREATE INDEX IF NOT EXISTS idx_lines_account ON journal_lines(account_id);
  CREATE INDEX IF NOT EXISTS idx_lines_party   ON journal_lines(party_id);

  -- TDS deducted, one row per deduction, each pointing at the journal that
  -- booked it. The register is derived from journals that exist, so it can
  -- never drift from the books — postVoucherWithTds writes both together.
  CREATE TABLE IF NOT EXISTS tds_challans (
    id           INTEGER PRIMARY KEY,
    fy           TEXT NOT NULL,
    quarter      INTEGER NOT NULL CHECK (quarter BETWEEN 1 AND 4),
    -- One challan covers ONE return form; a quarter can hold one of each, so
    -- the row must say which or the preparer can't pick the right challan
    -- number off the page.
    form         TEXT NOT NULL CHECK (form IN ('26Q','24Q')),
    challan_no   TEXT NOT NULL DEFAULT '',
    bsr_code     TEXT NOT NULL DEFAULT '',
    paid_on      TEXT NOT NULL,
    amount_paise INTEGER NOT NULL CHECK (amount_paise > 0),
    -- Same invariant as tds_entries: a challan claiming money was deposited
    -- must have the Dr 2300 / Cr Bank journal behind it.
    journal_id   INTEGER NOT NULL REFERENCES journals(id),
    created_at   TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS tds_entries (
    id           INTEGER PRIMARY KEY,
    party_id     INTEGER NOT NULL REFERENCES parties(id),
    section      TEXT NOT NULL,
    entry_date   TEXT NOT NULL,
    base_paise   INTEGER NOT NULL CHECK (base_paise >= 0),
    tds_paise    INTEGER NOT NULL CHECK (tds_paise >= 0),
    rate_bp      INTEGER NOT NULL CHECK (rate_bp >= 0),
    -- The journal this deduction lives in. NOT NULL: a register row without a
    -- posted journal behind it would be a claim with no book entry.
    journal_id   INTEGER NOT NULL REFERENCES journals(id),
    -- NULL until the deduction is deposited on a challan.
    challan_id   INTEGER REFERENCES tds_challans(id),
    created_at   TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_tds_entries_date ON tds_entries(entry_date);
  CREATE INDEX IF NOT EXISTS idx_tds_entries_challan ON tds_entries(challan_id);

  -- Computation metadata: never posted to the books, so freely editable.
  -- Addbacks raise taxable income (disallowances, unpaid statutory dues),
  -- deductions lower it. The section label is the office's own note — this
  -- app asserts no statutory numbering.
  CREATE TABLE IF NOT EXISTS it_adjustments (
    id           INTEGER PRIMARY KEY,
    fy           TEXT NOT NULL,
    kind         TEXT NOT NULL CHECK (kind IN ('addback','deduction')),
    section      TEXT NOT NULL DEFAULT '',
    description  TEXT NOT NULL,
    amount_paise INTEGER NOT NULL CHECK (amount_paise > 0),
    created_at   TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_it_adjustments_fy ON it_adjustments(fy);

  -- Tax already paid for the year, netted off the computed liability.
  CREATE TABLE IF NOT EXISTS tax_payments (
    id           INTEGER PRIMARY KEY,
    fy           TEXT NOT NULL,
    kind         TEXT NOT NULL CHECK (kind IN ('advance','tds','self_assessment')),
    paid_on      TEXT NOT NULL,
    amount_paise INTEGER NOT NULL CHECK (amount_paise > 0),
    note         TEXT NOT NULL DEFAULT '',
    created_at   TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_tax_payments_fy ON tax_payments(fy);

  -- Fixed-asset register. Depreciation runs on the IT-Act BLOCK, not per
  -- asset, so these rows exist to compute additions/disposals per block —
  -- the block CHECK list is frozen alongside IT_BLOCKS in tax/depreciation.ts.
  CREATE TABLE IF NOT EXISTS fixed_assets (
    id              INTEGER PRIMARY KEY,
    name            TEXT NOT NULL,
    block           TEXT NOT NULL CHECK (block IN
                    ('building','furniture','plant','vehicles','computers')),
    cost_paise      INTEGER NOT NULL CHECK (cost_paise > 0),
    purchase_date   TEXT NOT NULL,
    -- NULL = bought but not yet in use: no depreciation until it is.
    put_to_use_date TEXT,
    disposed_date   TEXT,
    disposal_paise  INTEGER,
    created_at      TEXT NOT NULL,
    CHECK ((disposed_date IS NULL) = (disposal_paise IS NULL)),
    CHECK (disposal_paise IS NULL OR disposal_paise >= 0),
    -- The timeline must hold at the schema level too: any direct-SQL path
    -- (import, script) that wrote an impossible order would still produce a
    -- confident-looking depreciation number.
    CHECK (put_to_use_date IS NULL OR put_to_use_date >= purchase_date),
    CHECK (disposed_date IS NULL OR
           (put_to_use_date IS NOT NULL AND disposed_date >= put_to_use_date))
  );

  -- Opening WDV carried in from books kept elsewhere (Tally, a prior CA).
  -- Overrides the rolled-forward closing for that FY only.
  CREATE TABLE IF NOT EXISTS wdv_openings (
    id            INTEGER PRIMARY KEY,
    fy            TEXT NOT NULL,
    block         TEXT NOT NULL CHECK (block IN
                  ('building','furniture','plant','vehicles','computers')),
    opening_paise INTEGER NOT NULL CHECK (opening_paise >= 0),
    created_at    TEXT NOT NULL,
    UNIQUE (fy, block)
  );

  -- One human mark per compliance item: done, or not-applicable. Everything
  -- else on the board (pending/overdue) is derived, never stored, so the
  -- calendar can't hold a stale status. Period strings are the item's own
  -- key (months absolute, quarters/ITR FY-prefixed — see lib/compliance.ts).
  CREATE TABLE IF NOT EXISTS compliance_marks (
    id        INTEGER PRIMARY KEY,
    rule_code TEXT NOT NULL,
    period    TEXT NOT NULL,
    status    TEXT NOT NULL CHECK (status IN ('done','na')),
    marked_at TEXT NOT NULL,
    note      TEXT NOT NULL DEFAULT '',
    UNIQUE (rule_code, period)
  );

  -- Tally ledger name → this book's account or party. Persistent: a ledger
  -- mapped once is never asked about again on later imports. ledger_name is
  -- UNIQUE so a name can only ever point at one target.
  CREATE TABLE IF NOT EXISTS ledger_mappings (
    id          INTEGER PRIMARY KEY,
    ledger_name TEXT NOT NULL UNIQUE,
    target_kind TEXT NOT NULL CHECK (target_kind IN ('account','party')),
    account_id  INTEGER REFERENCES accounts(id),
    party_id    INTEGER REFERENCES parties(id),
    created_at  TEXT NOT NULL,
    CHECK ((target_kind = 'account') = (account_id IS NOT NULL)),
    CHECK ((target_kind = 'party')   = (party_id   IS NOT NULL))
  );

  -- Auth (RVOS-003 P2). The office reaches this over Tailscale, so the tailnet
  -- is no longer the perimeter — a login is. Tailscale becomes defence in
  -- depth BEHIND this, not instead of it.
  -- One row per person who may open the books. Password is scrypt; salt and
  -- hash are hex and compared with timingSafeEqual. The lockout counter is
  -- STORED, not held in memory, so restarting the server cannot clear a
  -- brute-force attempt in progress.
  CREATE TABLE IF NOT EXISTS auth_users (
    id              INTEGER PRIMARY KEY,
    username        TEXT NOT NULL COLLATE NOCASE UNIQUE,
    password_hash   TEXT NOT NULL,
    password_salt   TEXT NOT NULL,
    created_at      TEXT NOT NULL,
    last_login_at   TEXT,
    failed_attempts INTEGER NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
    locked_until    TEXT
  );

  -- Sessions live server-side so a logout — or a lost laptop — can actually be
  -- revoked; a stateless signed cookie cannot be. The cookie carries a random
  -- 256-bit token and only its SHA-256 is stored, so a copied db file yields
  -- no usable session cookie.
  CREATE TABLE IF NOT EXISTS auth_sessions (
    token_sha256 TEXT PRIMARY KEY,
    user_id      INTEGER NOT NULL REFERENCES auth_users(id),
    created_at   TEXT NOT NULL,
    expires_at   TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    CHECK (expires_at > created_at)
  );
`;

/** Chart of accounts — seeded once, grouped via src/lib/coa.ts metadata. */
export const SEED_ACCOUNTS: {
  code: string;
  name: string;
  type: string;
  group_code: string;
}[] = [
  { code: "1000", name: "Cash", type: "asset", group_code: "current_assets" },
  { code: "1100", name: "Bank", type: "asset", group_code: "current_assets" },
  { code: "1200", name: "Accounts Receivable", type: "asset", group_code: "current_assets" },
  { code: "1300", name: "GST ITC", type: "asset", group_code: "duties_taxes" },
  { code: "1500", name: "Plant & Machinery", type: "asset", group_code: "fixed_assets" },
  { code: "1510", name: "Furniture & Fixtures", type: "asset", group_code: "fixed_assets" },
  { code: "1520", name: "Buildings", type: "asset", group_code: "fixed_assets" },
  { code: "1530", name: "Computers", type: "asset", group_code: "fixed_assets" },
  { code: "1540", name: "Vehicles", type: "asset", group_code: "fixed_assets" },
  { code: "1590", name: "Accumulated Depreciation", type: "asset", group_code: "fixed_assets" },
  { code: "2100", name: "Accounts Payable", type: "liability", group_code: "current_liabilities" },
  { code: "2200", name: "GST Output CGST", type: "liability", group_code: "duties_taxes" },
  { code: "2210", name: "GST Output SGST", type: "liability", group_code: "duties_taxes" },
  { code: "2220", name: "GST Output IGST", type: "liability", group_code: "duties_taxes" },
  { code: "2300", name: "TDS Payable", type: "liability", group_code: "duties_taxes" },
  { code: "3000", name: "Opening Balance Equity", type: "equity", group_code: "capital" },
  { code: "3100", name: "Capital Account", type: "equity", group_code: "capital" },
  { code: "3150", name: "Drawings", type: "equity", group_code: "capital" },
  { code: "4000", name: "Sales", type: "income", group_code: "income" },
  { code: "5000", name: "Purchases", type: "expense", group_code: "direct_expenses" },
  { code: "5800", name: "Depreciation", type: "expense", group_code: "indirect_expenses" },
  { code: "5900", name: "Expenses", type: "expense", group_code: "indirect_expenses" },
  { code: "5950", name: "Rounding", type: "expense", group_code: "indirect_expenses" },
];

/** DDL + additive migrations. Safe to run on every open (and on :memory: in
 * tests). */
export function initSchema(db: Database.Database): void {
  db.pragma("foreign_keys = ON");
  db.exec(DDL);
  // ensureColumn() slots — additive migrations, run on every open.
  ensureColumn(db, "accounts", "group_code", "TEXT");
  ensureColumn(db, "settings", "entity_type", "TEXT NOT NULL DEFAULT 'proprietorship'");
  ensureColumn(db, "settings", "pan", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "settings", "tan", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "settings", "it_regime", "TEXT NOT NULL DEFAULT 'new'");
  ensureColumn(db, "settings", "presumptive", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "settings", "books_locked_through", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "settings", "fy_audit_case", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(
    db,
    "documents",
    "source_type",
    "TEXT NOT NULL DEFAULT 'photo' CHECK (source_type IN ('photo','excel','tally'))"
  );
  // NULL = the document's party; imports may carry a party per row.
  ensureColumn(db, "staged_rows", "party_id", "INTEGER REFERENCES parties(id)");
  // A payee's PAN — its absence forces the penal TDS rate, so it is a fact
  // about the party, not about any one deduction.
  ensureColumn(db, "parties", "pan", "TEXT NOT NULL DEFAULT ''");
}

/** Settings singleton + chart of accounts. Idempotent — also backfills
 * group_code on pre-grouping books. */
export function seedCoreData(db: Database.Database): void {
  db.prepare("INSERT OR IGNORE INTO settings (id) VALUES (1)").run();
  const insert = db.prepare(
    `INSERT OR IGNORE INTO accounts (code, name, type, group_code)
     VALUES (@code, @name, @type, @group_code)`
  );
  const backfill = db.prepare(
    "UPDATE accounts SET group_code = @group_code WHERE code = @code AND group_code IS NULL"
  );
  const tx = db.transaction(() => {
    for (const a of SEED_ACCOUNTS) {
      insert.run(a);
      backfill.run({ code: a.code, group_code: a.group_code });
    }
  });
  tx();
}

/**
 * Chart of accounts for ONE newly onboarded client — RVOS-004 P4.
 *
 * Deliberately NOT `seedCoreData`: that function is company-1-specific global
 * bootstrap that runs on every boot and implicitly defaults `company_id` to 1
 * (see the DDL's `DEFAULT 1`). Repurposing it for an arbitrary company would
 * either silently keep landing accounts on company 1 or require threading a
 * company id through a function every other caller expects to be
 * boot-time/global. `accounts.code`'s UNIQUE is `(company_id, code)` since
 * migration 001, so this is safe to call once per new company — and
 * `INSERT OR IGNORE` keeps it idempotent if it is ever called twice.
 */
export function seedAccountsForCompany(db: Database.Database, companyId: number): void {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO accounts (company_id, code, name, type, group_code)
     VALUES (@company_id, @code, @name, @type, @group_code)`
  );
  const tx = db.transaction(() => {
    for (const a of SEED_ACCOUNTS) {
      insert.run({ company_id: companyId, ...a });
    }
    seedBankAccounts(db, companyId);
  });
  tx();
}

/**
 * Wrap a new company's seeded Cash and Bank ledgers in `bank_accounts` rows —
 * RVOS-006 P0a.
 *
 * Deliberately called from INSIDE `seedAccountsForCompany` rather than left to
 * its callers. Migration 004 does this for every company that existed when it
 * ran, but a company onboarded afterwards would otherwise get a chart of
 * accounts with no bank accounts wrapping it — and then every import and
 * voucher for that client would fail at `defaultForHint`, because there is no
 * account for a 'cash' or 'bank' row to resolve to. One call site means there
 * is nowhere to forget it.
 */
function seedBankAccounts(db: Database.Database, companyId: number): void {
  const findAccount = db.prepare(
    "SELECT id FROM accounts WHERE company_id = @companyId AND code = @code"
  );
  const insert = db.prepare(
    `INSERT OR IGNORE INTO bank_accounts
       (company_id, name, kind, account_id, is_default, created_at)
     VALUES (@companyId, @name, @kind, @accountId, 1, @now)`
  );
  const now = new Date().toISOString();
  for (const seed of [
    { code: "1000", name: "Cash", kind: "cash" },
    { code: "1100", name: "Bank", kind: "bank" },
  ]) {
    const account = findAccount.get({ companyId, code: seed.code }) as
      | { id: number }
      | undefined;
    if (!account) {
      throw new Error(
        `Cannot seed bank accounts for company ${companyId}: ledger ${seed.code} is missing.`
      );
    }
    insert.run({
      companyId,
      name: seed.name,
      kind: seed.kind,
      accountId: account.id,
      now,
    });
  }
}

/** Demo parties so DEMO_MODE works on a fresh db without any setup. */
export function seedDemoParties(db: Database.Database): void {
  const count = db.prepare("SELECT COUNT(*) AS n FROM parties").get() as {
    n: number;
  };
  if (count.n > 0) return;
  const insert = db.prepare(
    `INSERT INTO parties (name, kind, gstin, state_code, phone, created_at)
     VALUES (?, ?, '', ?, '', ?)`
  );
  const now = new Date().toISOString();
  insert.run("Sharma Traders", "customer", "27", now);
  insert.run("Gupta Suppliers", "supplier", "07", now);
}

// Present for parity with the house db pattern; use for any post-v1 column.
export function ensureColumn(
  db: Database.Database,
  table: string,
  col: string,
  ddl: string
): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as {
    name: string;
  }[];
  if (!cols.some((c) => c.name === col)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
  }
}

/**
 * Connection-level durability settings.
 *
 * WHY THE CHECKPOINT (learned the hard way, 2026-07-21): SQLite's default
 * auto-checkpoint fires at 1000 WAL pages (~4 MB). A small book NEVER reaches
 * it, so every committed row can sit in `revenueos.db-wal` indefinitely while
 * `revenueos.db` itself stays a 4 KB stub containing no tables at all.
 *
 * Anything that treats the .db file as "the database" then silently reads or
 * destroys an empty book: a file copy, an rsync, a sha256 integrity check, a
 * restic snapshot that races the sidecars, or a well-meaning cleanup of
 * -wal/-shm. This repo's live ledger was lost exactly that way and had to be
 * recovered from a stale copy in another process's scratch directory.
 *
 * Checkpointing on open means the .db file becomes a real book within one
 * restart, and the lowered threshold keeps it that way during a long run.
 * This does NOT make a plain file copy safe — use scripts/backup.ts, which
 * goes through SQLite's online backup API — but it removes the failure mode
 * where the main file is empty for days at a time.
 */
export function configureConnection(db: Database.Database): void {
  db.pragma("journal_mode = WAL");
  db.pragma("wal_checkpoint(TRUNCATE)");
  db.pragma("wal_autocheckpoint = 64");
}

/**
 * Run pending migrations with NO pre-migration snapshot.
 *
 * This is what every ordinary app boot does — dev, test, and a normal
 * `npm start`. It is still transactionally safe: `migrate()` runs each step
 * in its own transaction, re-proves the books balance after every step, and
 * rolls back on any failure (see migrate.ts). What it does NOT do is take an
 * external, independently-verified backup first.
 *
 * `createBackup` (backup.ts) is genuinely async — it drives SQLite's online
 * backup API — and `getDb()` is a synchronous singleton called from many
 * places that cannot await it. Restructuring that is out of scope here.
 *
 * The real, once-ever cutover of an office's live database is NOT this path:
 * it is `npm run migrate` (scripts/migrate.ts), which takes and verifies a
 * real backup first and only then calls this same `migrate()` with that
 * backup's path already in hand. Because migrations are idempotent, running
 * that script before the app's first post-upgrade boot makes this call here
 * a no-op — which is the intended order of operations, not a race.
 */
function migrateInProcess(db: Database.Database): void {
  migrate(db, MIGRATIONS, { now: new Date().toISOString() });
}

function open(): Database.Database {
  mkdirSync(UPLOADS_DIR, { recursive: true });
  const db = new Database(path.join(DATA_DIR, "revenueos.db"));
  configureConnection(db);
  initSchema(db);
  seedCoreData(db);
  migrateInProcess(db);
  if (process.env.DEMO_MODE === "1") seedDemoParties(db);
  return db;
}

export function getDb(): Database.Database {
  if (!global.__revenueosDb) global.__revenueosDb = open();
  return global.__revenueosDb;
}
