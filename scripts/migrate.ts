/**
 * Apply pending schema migrations to the REAL database, with a verified
 * backup taken first — the deliberate, once-per-upgrade path (RVOS-004 P3).
 *
 *   npm run migrate
 *   REVENUEOS_BACKUP_DIR=D:\\revenueos-backups npm run migrate
 *
 * Every ordinary `npm run dev` / `npm start` ALSO calls migrate() (see
 * migrateInProcess in src/lib/db.ts), but without a pre-migration backup:
 * getDb() is a synchronous singleton and cannot await the online backup API.
 * Run this script BEFORE the app's first boot after an upgrade that ships a
 * new migration — migrations are idempotent, so the app's own in-process
 * call becomes a safe no-op afterwards, not a race.
 *
 * Rehearse this against a COPY of the real database before ever pointing it
 * at the office's live file (RVOS-004 P6 ship gate).
 */
import path from "node:path";
import Database from "better-sqlite3";
import { createBackup } from "../src/lib/backup";
import { configureConnection, initSchema, seedCoreData } from "../src/lib/db";
import { currentVersion, migrate } from "../src/lib/migrate";
import { MIGRATIONS } from "../src/lib/migrations";

const DATA_DIR = path.join(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "revenueos.db");
const UPLOADS_DIR = path.join(DATA_DIR, "uploads");
const BACKUP_DIR = process.env.REVENUEOS_BACKUP_DIR ?? path.join(DATA_DIR, "backups");

async function main(): Promise<void> {
  const now = new Date().toISOString();
  const db = new Database(DB_PATH);
  configureConnection(db);
  initSchema(db);
  seedCoreData(db);

  const from = currentVersion(db);
  const target = Math.max(0, ...MIGRATIONS.map((m) => m.version));
  if (from >= target) {
    console.log(`Already at schema version ${from}. Nothing to do.`);
    db.close();
    return;
  }

  console.log(`Schema version ${from} → ${target}. Taking a verified backup first…`);
  const backup = await createBackup(db, BACKUP_DIR, now, UPLOADS_DIR);
  console.log(`✓ Backup verified: ${backup.dir}`);

  const result = migrate(db, MIGRATIONS, {
    now,
    // The backup already happened, above, and was verified — this closure
    // reports its path. migrate() still refuses to run any DDL if a backup
    // step throws; it simply cannot throw here, because we would not have
    // reached this line.
    backup: () => ({ path: backup.db_path }),
  });

  console.log(
    `✓ Applied: ${result.applied.map((a) => `${a.version} (${a.name})`).join(", ") || "(none)"}`
  );
  console.log(`  Now at schema version ${result.nowAtVersion}.`);
  console.log(`  Pre-migration snapshot: ${backup.dir}`);
  db.close();
}

main().catch((err) => {
  console.error(`✗ Migration FAILED: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
