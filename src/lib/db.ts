import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";

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
`;

/** Chart of accounts — 13 accounts, seeded once. */
export const SEED_ACCOUNTS: { code: string; name: string; type: string }[] = [
  { code: "1000", name: "Cash", type: "asset" },
  { code: "1100", name: "Bank", type: "asset" },
  { code: "1200", name: "Accounts Receivable", type: "asset" },
  { code: "1300", name: "GST ITC", type: "asset" },
  { code: "2100", name: "Accounts Payable", type: "liability" },
  { code: "2200", name: "GST Output CGST", type: "liability" },
  { code: "2210", name: "GST Output SGST", type: "liability" },
  { code: "2220", name: "GST Output IGST", type: "liability" },
  { code: "3000", name: "Opening Balance Equity", type: "equity" },
  { code: "4000", name: "Sales", type: "income" },
  { code: "5000", name: "Purchases", type: "expense" },
  { code: "5900", name: "Expenses", type: "expense" },
  { code: "5950", name: "Rounding", type: "expense" },
];

/** DDL + additive migrations. Safe to run on every open (and on :memory: in
 * tests). */
export function initSchema(db: Database.Database): void {
  db.pragma("foreign_keys = ON");
  db.exec(DDL);
  // ensureColumn() slots for future additive migrations go here.
}

/** Settings singleton + chart of accounts. Idempotent. */
export function seedCoreData(db: Database.Database): void {
  db.prepare("INSERT OR IGNORE INTO settings (id) VALUES (1)").run();
  const insert = db.prepare(
    "INSERT OR IGNORE INTO accounts (code, name, type) VALUES (@code, @name, @type)"
  );
  const tx = db.transaction(() => {
    for (const a of SEED_ACCOUNTS) insert.run(a);
  });
  tx();
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

function open(): Database.Database {
  mkdirSync(UPLOADS_DIR, { recursive: true });
  const db = new Database(path.join(DATA_DIR, "revenueos.db"));
  db.pragma("journal_mode = WAL");
  initSchema(db);
  seedCoreData(db);
  if (process.env.DEMO_MODE === "1") seedDemoParties(db);
  return db;
}

export function getDb(): Database.Database {
  if (!global.__revenueosDb) global.__revenueosDb = open();
  return global.__revenueosDb;
}
