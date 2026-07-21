/**
 * Take a backup. This is what the Windows Scheduled Task runs (RVOS-003 P4).
 *
 *   npm run backup
 *   REVENUEOS_BACKUP_DIR=D:\\revenueos-backups npm run backup
 *
 * Safe to run while the app is serving: SQLite's online backup API takes a
 * consistent snapshot of a database being written to.
 *
 * ── Read this before trusting it ──
 * The default destination is `data/backups`, which is ON THE SAME DISK as the
 * book it protects. That survives a mistake; it does not survive the disk, the
 * machine being stolen, or ransomware. Point REVENUEOS_BACKUP_DIR at an
 * external drive or a synced folder, and check `npm run restore -- --list`
 * occasionally. A backup nobody has ever restored is a rumour.
 */
import path from "node:path";
import Database from "better-sqlite3";
import {
  createBackup,
  DEFAULT_RETENTION,
  listBackups,
  pruneBackups,
} from "../src/lib/backup";

const DATA_DIR = path.join(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "revenueos.db");
const UPLOADS_DIR = path.join(DATA_DIR, "uploads");
const BACKUP_DIR = process.env.REVENUEOS_BACKUP_DIR ?? path.join(DATA_DIR, "backups");

async function main(): Promise<void> {
  const now = new Date().toISOString();
  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  try {
    const result = await createBackup(db, BACKUP_DIR, now, UPLOADS_DIR);
    const mb = (result.bytes / 1024 / 1024).toFixed(2);
    console.log(`✓ ${result.dir}`);
    console.log(`  ${mb} MB · sha256 ${result.sha256.slice(0, 16)}… · ${result.uploads_copied} uploads`);

    const removed = pruneBackups(BACKUP_DIR, DEFAULT_RETENTION);
    if (removed.length) {
      console.log(`  pruned ${removed.length}: ${removed.map((r) => r.name).join(", ")}`);
    }
    console.log(`  ${listBackups(BACKUP_DIR).length} snapshots retained in ${BACKUP_DIR}`);

    if (!process.env.REVENUEOS_BACKUP_DIR) {
      console.log(
        "\n⚠ Backups are on the SAME DISK as the books. Set REVENUEOS_BACKUP_DIR\n" +
          "  to an external or synced location — this protects against mistakes,\n" +
          "  not against losing the machine."
      );
    }
  } finally {
    db.close();
  }
}

main().catch((err) => {
  console.error(`✗ Backup FAILED: ${err instanceof Error ? err.message : err}`);
  // Non-zero so the Scheduled Task reports a failure instead of a silent skip.
  process.exit(1);
});
