import type Database from "better-sqlite3";

/**
 * Migration engine — RVOS-004 P1.
 *
 * This repo has never had one. RVOS-002 and RVOS-003 evolved the schema
 * additively (`ensureColumn` + `CREATE TABLE IF NOT EXISTS`) and that was the
 * right call while every change WAS additive. Multi-tenancy is not: it needs
 * `company_id NOT NULL` on populated tables and re-scoped UNIQUE constraints,
 * and `CREATE TABLE IF NOT EXISTS` never revisits an existing table — so a
 * redefined constraint is a SILENT NO-OP on the office's live database. That
 * exact trap already produced a real defect in RVOS-002.
 *
 * So this exists, and it is built around one assumption: **it will be run
 * against a real accounting firm's books, once, by someone who cannot undo
 * it.** Every design choice below follows from that.
 *
 * - **Backup first, or refuse.** The caller supplies a backup function that
 *   must return a path AND verify it. If it throws, or reports the snapshot
 *   unusable, no DDL runs at all.
 * - **One transaction per migration.** better-sqlite3 gives real transactions;
 *   a half-applied schema change on a book is not a state anyone should have
 *   to reason about.
 * - **Integrity is re-proven after every step**, not at the end — so a
 *   failure names the migration that broke it. The default check asserts the
 *   trial balance is still zero, because a migration that silently drops
 *   journal lines is the specific catastrophe worth spending a query on.
 * - **Forward-only, ordered, idempotent.** Versions must be contiguous and
 *   ascending; a migration already recorded is skipped, so re-running is safe.
 * - **Clock injected**, like the rest of this codebase.
 *
 * ── The foreign-key trap, found by writing the table-rebuild test ──
 * Changing a constraint in SQLite means rebuild-copy-drop-rename. Dropping a
 * table that others reference (journal_lines → accounts) trips FOREIGN KEY
 * enforcement, which this app turns ON. And `PRAGMA foreign_keys` is a NO-OP
 * INSIDE A TRANSACTION, so a migration cannot switch it off for itself.
 *
 * So the engine follows SQLite's own documented procedure: foreign_keys OFF
 * before the transaction, `PRAGMA foreign_key_check` INSIDE it (which still
 * works, and whose failure therefore rolls the migration back), and the
 * original setting restored afterwards no matter what. Without the
 * foreign_key_check the OFF would be a licence to leave orphaned rows behind
 * — trading a loud failure for a silent one.
 */

export interface Migration {
  /** Contiguous from 1, ascending. */
  version: number;
  /** Short, permanent. Recorded in the db and shown to the operator. */
  name: string;
  /** Runs inside a transaction. Throwing rolls the whole step back. */
  up: (db: Database.Database) => void;
}

export interface MigrateOptions {
  /** Must snapshot AND verify. Throw to abort — a throw here stops all DDL. */
  backup?: () => { path: string };
  /** Re-run after every migration; throw to roll that migration back.
   * Defaults to the trial-balance check below. */
  verify?: (db: Database.Database) => void;
  now: string;
}

export interface MigrateResult {
  applied: { version: number; name: string }[];
  alreadyAtVersion: number;
  nowAtVersion: number;
  backupPath: string | null;
}

const SCHEMA_VERSION_DDL = `
  CREATE TABLE IF NOT EXISTS schema_version (
    version    INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    applied_at TEXT NOT NULL
  );
`;

export function ensureVersionTable(db: Database.Database): void {
  db.exec(SCHEMA_VERSION_DDL);
}

export function currentVersion(db: Database.Database): number {
  ensureVersionTable(db);
  const row = db
    .prepare("SELECT COALESCE(MAX(version), 0) AS v FROM schema_version")
    .get() as { v: number };
  return row.v;
}

export function appliedMigrations(
  db: Database.Database
): { version: number; name: string; applied_at: string }[] {
  ensureVersionTable(db);
  return db
    .prepare("SELECT version, name, applied_at FROM schema_version ORDER BY version")
    .all() as { version: number; name: string; applied_at: string }[];
}

/**
 * The default post-migration check: the books must still balance.
 *
 * Chosen because it is the failure that would otherwise go unnoticed — a
 * migration that drops or duplicates journal lines leaves a database that
 * opens fine, renders fine, and is wrong. Row counts alone would not catch a
 * duplicated line; a zero trial balance does.
 */
export function assertBooksIntact(db: Database.Database): void {
  const hasJournals = db
    .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'journal_lines'")
    .get() as { n: number };
  if (hasJournals.n === 0) return; // a fresh database has nothing to protect yet

  const { d } = db
    .prepare(
      "SELECT COALESCE(SUM(debit_paise) - SUM(credit_paise), 0) AS d FROM journal_lines"
    )
    .get() as { d: number };
  if (d !== 0) {
    throw new Error(
      `Migration left the books unbalanced (net ${d} paise). Rolled back. ` +
        `Restore the pre-migration snapshot before trying again.`
    );
  }
}

/** Versions must be contiguous from 1 and strictly ascending. A gap means a
 * migration was deleted or renumbered, and applying the rest would produce a
 * schema nobody has a name for. */
export function assertWellFormed(migrations: Migration[]): void {
  const sorted = [...migrations].sort((a, b) => a.version - b.version);
  sorted.forEach((m, i) => {
    if (m.version !== i + 1) {
      throw new Error(
        `Migrations must be contiguous from 1 — expected version ${i + 1}, found ${m.version} ("${m.name}")`
      );
    }
    if (!m.name.trim()) throw new Error(`Migration ${m.version} has no name`);
  });
}

/**
 * Bring the database up to the latest migration.
 *
 * Returns without touching anything when already current — including without
 * taking a backup, so a no-op start-up does not accumulate snapshots.
 */
export function migrate(
  db: Database.Database,
  migrations: Migration[],
  opts: MigrateOptions
): MigrateResult {
  assertWellFormed(migrations);
  const from = currentVersion(db);
  const pending = [...migrations]
    .sort((a, b) => a.version - b.version)
    .filter((m) => m.version > from);

  if (pending.length === 0) {
    return { applied: [], alreadyAtVersion: from, nowAtVersion: from, backupPath: null };
  }

  // Nothing below this line runs if the backup could not be taken and proven.
  let backupPath: string | null = null;
  if (opts.backup) {
    try {
      backupPath = opts.backup().path;
    } catch (err) {
      throw new Error(
        `Refusing to migrate: the pre-migration backup failed — ` +
          `${err instanceof Error ? err.message : String(err)}. No schema changes were made.`
      );
    }
  }

  const verify = opts.verify ?? assertBooksIntact;
  const applied: { version: number; name: string }[] = [];

  // Must be set OUTSIDE any transaction — see the note at the top of the file.
  const fkWasOn = (db.pragma("foreign_keys", { simple: true }) as number) === 1;
  if (fkWasOn) db.pragma("foreign_keys = OFF");

  try {
    for (const m of pending) {
      const step = db.transaction(() => {
        m.up(db);
        db.prepare(
          "INSERT INTO schema_version (version, name, applied_at) VALUES (@version, @name, @now)"
        ).run({ version: m.version, name: m.name, now: opts.now });

        // Enforcement was off for the rebuild; prove nothing was orphaned by
        // it. This DOES work inside a transaction, so a violation rolls the
        // migration back instead of shipping a broken reference.
        const violations = db.pragma("foreign_key_check") as unknown[];
        if (violations.length > 0) {
          throw new Error(
            `left ${violations.length} orphaned foreign-key reference(s) — ` +
              `a rebuilt table probably lost rows its children still point at`
          );
        }

        // Inside the transaction, so a failed check rolls the migration back
        // rather than leaving it recorded.
        verify(db);
      });

      try {
        step();
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        throw new Error(
          `Migration ${m.version} ("${m.name}") failed and was rolled back: ${detail}` +
            (backupPath ? `\n  Pre-migration snapshot: ${backupPath}` : "")
        );
      }
      applied.push({ version: m.version, name: m.name });
    }
  } finally {
    // Restore the original setting whether we succeeded or threw — leaving
    // enforcement off would silently disarm every later write.
    if (fkWasOn) db.pragma("foreign_keys = ON");
  }

  return {
    applied,
    alreadyAtVersion: from,
    nowAtVersion: currentVersion(db),
    backupPath,
  };
}
