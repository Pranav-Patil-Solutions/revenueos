import type Database from "better-sqlite3";
import DatabaseCtor from "better-sqlite3";
import {
  cpSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { SCOPED_TABLES } from "./book";
import { initSchema } from "./db";
import { migrate } from "./migrate";
import { MIGRATIONS } from "./migrations";

/**
 * Backups — RVOS-003 P3.
 *
 * The office's books will live on ONE Windows machine. Until now the only
 * copy of `data/revenueos.db` was that disk, and "automated backups" sat in
 * the README's deferred list. For a delivered product holding a client's
 * statutory records, that is not a deferrable item.
 *
 * Three decisions worth stating:
 *
 * - **Never file-copy a live SQLite database.** The db runs in WAL mode, so a
 *   plain copy of the .db captures a file whose committed state lives partly
 *   in a -wal sidecar it did not copy. The result looks like a backup and can
 *   restore to a torn state. better-sqlite3's `.backup()` is SQLite's online
 *   backup API and takes a consistent snapshot of a database being written to.
 *
 * - **A backup is not verified by existing.** Every backup is re-opened and
 *   integrity-checked before it counts, and the test suite performs a real
 *   RESTORE and asserts the books come back — row counts AND a zero trial
 *   balance. An untested backup is worse than none: it converts a recoverable
 *   incident into a discovery, at the worst possible moment.
 *
 * - **A restore is destructive, so it takes its own backup first.** Restoring
 *   over a live book is exactly when someone is panicking; the pre-restore
 *   snapshot is what makes the panic recoverable.
 *
 * Clock-free: `now` is injected, like compliance.ts and auth.ts, so retention
 * is testable without touching the system clock.
 */

export const BACKUP_PREFIX = "revenueos-";
export const DB_BASENAME = "revenueos.db";

export interface BackupResult {
  /** Directory holding the snapshot. */
  dir: string;
  db_path: string;
  bytes: number;
  sha256: string;
  created_at: string;
  uploads_copied: number;
}

export interface CompanyExportResult {
  dir: string;
  db_path: string;
  bytes: number;
  sha256: string;
  created_at: string;
  company_id: number;
  /** Row count actually copied, per scoped table — visible so "0 accounts,
   * 0 journals" reads as a red flag rather than a silent empty export. */
  row_counts: Record<string, number>;
  uploads_copied: number;
  uploads_expected: number;
}

export interface BackupFile {
  dir: string;
  name: string;
  created_at: string;
}

/** "2026-07-21T09:30:00.000Z" → "20260721-093000" (filesystem-safe, sorts). */
export function stampFor(now: string): string {
  const d = new Date(now);
  if (Number.isNaN(d.getTime())) throw new Error(`Bad timestamp "${now}"`);
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`
  );
}

/** Parse a snapshot directory name back to its instant; null if not ours. */
export function instantOf(name: string): Date | null {
  const m = name.match(/^revenueos-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const iso = `${y}-${mo}-${d}T${h}:${mi}:${s}.000Z`;
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(file)
      .on("error", reject)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve(hash.digest("hex")));
  });
}

/**
 * Take a snapshot. `db` must be the LIVE connection — SQLite's online backup
 * API reads through it, which is what makes the snapshot consistent while the
 * app is running.
 */
export async function createBackup(
  db: Database.Database,
  backupsDir: string,
  now: string,
  uploadsDir?: string
): Promise<BackupResult> {
  const dir = path.join(backupsDir, `${BACKUP_PREFIX}${stampFor(now)}`);
  mkdirSync(dir, { recursive: true });

  const dbPath = path.join(dir, DB_BASENAME);
  // SQLite's online backup — NOT a file copy. See the module comment.
  await db.backup(dbPath);

  const problem = verifyBackup(dbPath);
  if (problem) {
    // A snapshot that fails its own check must not be left behind looking
    // like a good one.
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`Backup failed verification and was discarded: ${problem}`);
  }

  let uploads = 0;
  if (uploadsDir && existsSync(uploadsDir)) {
    try {
      const dest = path.join(dir, "uploads");
      cpSync(uploadsDir, dest, { recursive: true });
      uploads = readdirSync(dest).length;
    } catch (err) {
      // A snapshot with a verified db but half its ledger photos would still
      // list as good. Discard the whole thing rather than leave a "\u2713" on
      // something incomplete.
      rmSync(dir, { recursive: true, force: true });
      throw new Error(
        `Backup failed while copying uploads and was discarded: ` +
          `${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  return {
    dir,
    db_path: dbPath,
    bytes: statSync(dbPath).size,
    sha256: await sha256File(dbPath),
    created_at: now,
    uploads_copied: uploads,
  };
}

/**
 * Export ONE company's own books into a standalone database — RVOS-004 P5.
 *
 * `npm run backup` protects the whole office; this is for the day a client
 * asks for their own books, or moves their books to their own CA. Handing
 * over the whole-DB backup would hand over every OTHER client's data too —
 * "an import posting into the wrong client's books" was P4's worst failure
 * mode, and an export leaking a second client's data into a handoff file is
 * the mirror image of it, so this is built and verified with the same
 * paranoia (see the `opts.companyId` mode of `verifyBackup`).
 *
 * The output is a real, openable SQLite database at the CURRENT schema
 * (built via `initSchema` + the full migration chain, not a copy of the live
 * file), containing only: that one row from `companies`, and every row this
 * company owns across `SCOPED_TABLES`. IDs are preserved as-is — every
 * foreign key inside one company's own data already only ever points at that
 * company's own rows, so no remapping is needed or attempted.
 *
 * Deliberately NOT copied: `auth_users` / `auth_sessions` (firm staff
 * credentials belong to this office's installation, never to a client
 * handoff). The company's own profile/tax-identity fields ARE copied — they
 * now live on its own `companies` row (RVOS-004 P6 retired the old GLOBAL
 * `settings` singleton), so exporting that one row is exactly right, not a
 * cross-company leak.
 */
export async function exportCompany(
  sourceDb: Database.Database,
  companyId: number,
  backupsDir: string,
  now: string,
  filesRoot?: string
): Promise<CompanyExportResult> {
  const company = sourceDb
    .prepare("SELECT * FROM companies WHERE id = @id")
    .get({ id: companyId }) as Record<string, unknown> | undefined;
  if (!company) throw new Error(`No such company: ${companyId}`);

  const dir = path.join(backupsDir, `${BACKUP_PREFIX}company-${companyId}-${stampFor(now)}`);
  mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, DB_BASENAME);

  const rowCounts: Record<string, number> = {};
  try {
    const dest = new DatabaseCtor(dbPath);
    try {
      initSchema(dest);
      migrate(dest, MIGRATIONS, { now });

      const insertRow = (table: string, row: Record<string, unknown>): void => {
        const cols = Object.keys(row);
        dest
          .prepare(
            `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols
              .map((c) => `@${c}`)
              .join(", ")})`
          )
          .run(row);
      };

      // Read every table from ONE snapshot of sourceDb: without this,
      // concurrent writes from the live app between two of these SELECTs
      // (e.g. a journal committed after its account but before its lines)
      // could produce a torn, non-atomic export — the CLI promises "safe to
      // run while the app is serving," so the read side needs the same
      // consistency guarantee createBackup's online-backup API gives the
      // whole-db path.
      const tableRows: Record<string, Record<string, unknown>[]> = sourceDb.transaction(() => {
        const snapshot: Record<string, Record<string, unknown>[]> = {};
        for (const table of SCOPED_TABLES) {
          snapshot[table] = sourceDb
            .prepare(`SELECT * FROM ${table} WHERE company_id = @company_id`)
            .all({ company_id: companyId }) as Record<string, unknown>[];
        }
        return snapshot;
      })();

      // `defer_foreign_keys` (not the ordering of SCOPED_TABLES) is what keeps
      // this correct: tds_entries.challan_id REFERENCES tds_challans(id), but
      // tds_entries is copied first in SCOPED_TABLES order. Deferring checks
      // to commit means insertion order never has to match FK dependency
      // order — a real requirement caught in review, verified with a
      // reconciled-challan fixture in test/backup.test.ts.
      dest.pragma("defer_foreign_keys = ON");
      dest.transaction(() => {
        insertRow("companies", company);
        for (const table of SCOPED_TABLES) {
          rowCounts[table] = tableRows[table].length;
          for (const row of tableRows[table]) insertRow(table, row);
        }
      })();
    } finally {
      dest.close();
    }

    const problem = verifyBackup(dbPath, { companyId });
    if (problem) {
      throw new Error(`Company export failed verification: ${problem}`);
    }

    let uploadsCopied = 0;
    let uploadsExpected = 0;
    if (filesRoot) {
      const docs = sourceDb
        .prepare("SELECT image_path FROM documents WHERE company_id = @company_id")
        .all({ company_id: companyId }) as { image_path: string }[];
      uploadsExpected = docs.length;
      if (docs.length > 0) {
        const destUploads = path.join(dir, "uploads");
        mkdirSync(destUploads, { recursive: true });
        for (const { image_path } of docs) {
          const src = path.join(filesRoot, image_path);
          // Best-effort: an older/pruned upload should not fail the whole
          // export — uploads_copied vs uploads_expected makes a gap visible
          // rather than silent, which is the property that actually matters.
          if (existsSync(src)) {
            cpSync(src, path.join(destUploads, path.basename(image_path)));
            uploadsCopied++;
          }
        }
      }
    }

    return {
      dir,
      db_path: dbPath,
      bytes: statSync(dbPath).size,
      sha256: await sha256File(dbPath),
      created_at: now,
      company_id: companyId,
      row_counts: rowCounts,
      uploads_copied: uploadsCopied,
      uploads_expected: uploadsExpected,
    };
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    throw err instanceof Error ? err : new Error(String(err));
  }
}

/**
 * Re-open a snapshot and prove it is a usable book. Returns null when good, or
 * a description of the problem.
 *
 * `PRAGMA integrity_check` alone is not enough — it proves the FILE is
 * structurally sound, not that it holds our schema. A zero-byte or foreign
 * database passes structural checks and would be a catastrophic thing to
 * restore, so the accounting tables are probed too.
 *
 * `opts.companyId` (RVOS-004 P5) turns on the per-company assertion a
 * company EXPORT needs: not just "this file has rows", but "this file has
 * ONLY this company's rows". A per-company export that leaked a second
 * client's data into the file would still pass the plain checks above — the
 * db is structurally fine and its journals still balance — which is exactly
 * why this is a separate, additive check rather than a replacement.
 */
export function verifyBackup(
  dbPath: string,
  opts?: { companyId?: number }
): string | null {
  if (!existsSync(dbPath)) return "file does not exist";
  let db: Database.Database | null = null;
  try {
    db = new DatabaseCtor(dbPath, { readonly: true, fileMustExist: true });
    const check = db.pragma("integrity_check") as { integrity_check: string }[];
    const verdict = check[0]?.integrity_check;
    if (verdict !== "ok") return `integrity_check said "${verdict}"`;

    for (const table of ["journals", "journal_lines", "accounts", "companies"]) {
      db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get();
    }
    const lines = db.prepare("SELECT COUNT(*) AS n FROM journal_lines").get() as {
      n: number;
    };
    const sum = db
      .prepare(
        "SELECT COALESCE(SUM(debit_paise) - SUM(credit_paise), 0) AS d FROM journal_lines"
      )
      .get() as { d: number };
    // A restored book whose journals do not balance is not a book.
    if (lines.n > 0 && sum.d !== 0) {
      return `restored journal lines do not balance (net ${sum.d} paise)`;
    }

    if (opts?.companyId !== undefined) {
      const companies = db.prepare("SELECT id FROM companies").all() as { id: number }[];
      if (companies.length !== 1 || companies[0].id !== opts.companyId) {
        return (
          `expected exactly one company (id ${opts.companyId}) in a per-company ` +
          `export, found: ${companies.map((c) => c.id).join(", ") || "none"}`
        );
      }
      for (const table of SCOPED_TABLES) {
        const leaked = db
          .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE company_id != @id`)
          .get({ id: opts.companyId }) as { n: number };
        if (leaked.n > 0) {
          return `${table} has ${leaked.n} row(s) belonging to a DIFFERENT company — export leaked`;
        }
      }
    }

    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  } finally {
    db?.close();
  }
}

export function listBackups(backupsDir: string): BackupFile[] {
  if (!existsSync(backupsDir)) return [];
  return readdirSync(backupsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => ({ name: e.name, instant: instantOf(e.name) }))
    .filter((e): e is { name: string; instant: Date } => e.instant !== null)
    .sort((a, b) => b.instant.getTime() - a.instant.getTime())
    .map((e) => ({
      dir: path.join(backupsDir, e.name),
      name: e.name,
      created_at: e.instant.toISOString(),
    }));
}

export interface RetentionPolicy {
  /** Most recent snapshots always kept, whatever their age. */
  keepRecent: number;
  /** Additionally keep the newest snapshot of each of the last N ISO weeks. */
  keepWeeks: number;
}

export const DEFAULT_RETENTION: RetentionPolicy = { keepRecent: 14, keepWeeks: 8 };

/** ISO-ish week key, "2026-W30". Pure string math on a UTC date. */
function weekKey(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/**
 * Decide what to keep. PURE — returns the split, deletes nothing, so the
 * policy is testable without a filesystem full of fixtures.
 */
export function planRetention(
  files: BackupFile[],
  policy: RetentionPolicy = DEFAULT_RETENTION
): { keep: BackupFile[]; remove: BackupFile[] } {
  const sorted = [...files].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  const keep = new Set<string>();

  sorted.slice(0, policy.keepRecent).forEach((f) => keep.add(f.name));

  const seenWeeks = new Set<string>();
  for (const f of sorted) {
    const key = weekKey(new Date(f.created_at));
    if (seenWeeks.has(key)) continue;
    seenWeeks.add(key);
    if (seenWeeks.size <= policy.keepWeeks) keep.add(f.name);
  }

  return {
    keep: sorted.filter((f) => keep.has(f.name)),
    remove: sorted.filter((f) => !keep.has(f.name)),
  };
}

export function pruneBackups(
  backupsDir: string,
  policy: RetentionPolicy = DEFAULT_RETENTION
): BackupFile[] {
  const { remove } = planRetention(listBackups(backupsDir), policy);
  for (const f of remove) rmSync(f.dir, { recursive: true, force: true });
  return remove;
}

/**
 * Restore a snapshot over a target database path.
 *
 * The caller MUST have stopped the app first — this cannot detect a live
 * writer, and restoring under one would interleave with its WAL.
 *
 * Takes a pre-restore snapshot of whatever is currently there, because a
 * restore happens precisely when someone is under pressure and a wrong choice
 * of backup should not be terminal. Stale -wal/-shm sidecars are removed: left
 * behind, they belong to the REPLACED database and would be replayed over the
 * restored one.
 */
export function restoreBackup(
  backupDbPath: string,
  targetDbPath: string,
  now: string,
  uploadsTargetDir?: string
): {
  restored_from: string;
  previous_saved_to: string | null;
  uploads_restored: number;
} {
  const problem = verifyBackup(backupDbPath);
  if (problem) throw new Error(`Refusing to restore an unusable backup: ${problem}`);

  let previous: string | null = null;
  // Anything thrown from here on MUST name the preserved book. A restore that
  // fails silently looks identical to total data loss to the person running it.
  const withPrevious = (msg: string): Error =>
    new Error(
      previous
        ? `${msg}\n  Your previous books are UNHARMED at: ${previous}\n` +
          `  Rename that back to ${path.basename(targetDbPath)} to undo this.`
        : msg
    );

  try {
    if (existsSync(targetDbPath)) {
      const candidate = `${targetDbPath}.pre-restore-${stampFor(now)}`;
      renameSync(targetDbPath, candidate);
      // Only claim the book was preserved AFTER the move actually succeeded.
      // Assigning first would send a panicking operator to a path that does
      // not exist, in the event the rename itself threw.
      previous = candidate;
    }

    for (const sidecar of ["-wal", "-shm"]) {
      const f = `${targetDbPath}${sidecar}`;
      if (existsSync(f)) rmSync(f, { force: true });
    }

    // Copy to a temp name in the SAME directory, verify it landed intact, then
    // rename into place. rename is atomic within a filesystem, so an
    // interrupted or disk-full copy can never leave a half-written book at the
    // real path — the worst case is a stray .incoming file.
    const incoming = `${targetDbPath}.incoming-${stampFor(now)}`;
    try {
      cpSync(backupDbPath, incoming);
      const landed = verifyBackup(incoming);
      if (landed) throw withPrevious(`Restore copy is unusable: ${landed}`);
      renameSync(incoming, targetDbPath);
    } finally {
      if (existsSync(incoming)) rmSync(incoming, { force: true });
    }

    const after = verifyBackup(targetDbPath);
    if (after) throw withPrevious(`Restore landed an unusable database: ${after}`);

    // The ledger PHOTOS are part of the book: documents.image_path points at
    // them, so a db restored without its uploads leaves every document
    // referencing a file that is not there.
    let uploads = 0;
    const snapshotUploads = path.join(path.dirname(backupDbPath), "uploads");
    if (uploadsTargetDir && existsSync(snapshotUploads)) {
      mkdirSync(uploadsTargetDir, { recursive: true });
      cpSync(snapshotUploads, uploadsTargetDir, { recursive: true, force: true });
      uploads = readdirSync(snapshotUploads).length;
    }

    return { restored_from: backupDbPath, previous_saved_to: previous, uploads_restored: uploads };
  } catch (err) {
    if (err instanceof Error && err.message.includes("previous books are UNHARMED")) throw err;
    throw withPrevious(err instanceof Error ? err.message : String(err));
  }
}
