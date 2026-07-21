/**
 * Restore a backup over the live book. DESTRUCTIVE — read the guard rails.
 *
 *   npm run restore -- --list                 # what is available
 *   npm run restore -- --latest --yes
 *   npm run restore -- <path-to-snapshot-dir> --yes
 *
 * ── STOP THE APP FIRST ──
 * This cannot detect a running server. Restoring underneath one interleaves
 * with its WAL and can leave a torn database. On the office machine: stop the
 * RevenueOS scheduled task / close the window, run this, then start it again.
 *
 * The database being replaced is renamed to `revenueos.db.pre-restore-<stamp>`
 * rather than deleted — a restore happens when someone is already having a bad
 * day, and picking the wrong snapshot should not be terminal.
 */
import path from "node:path";
import { existsSync } from "node:fs";
import { listBackups, restoreBackup, verifyBackup, DB_BASENAME } from "../src/lib/backup";

const DATA_DIR = path.join(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "revenueos.db");
const BACKUP_DIR = process.env.REVENUEOS_BACKUP_DIR ?? path.join(DATA_DIR, "backups");

const args = process.argv.slice(2);
const has = (flag: string) => args.includes(flag);

function list(): void {
  const found = listBackups(BACKUP_DIR);
  if (!found.length) {
    console.log(`No snapshots in ${BACKUP_DIR}.`);
    return;
  }
  console.log(`${found.length} snapshot(s) in ${BACKUP_DIR}, newest first:\n`);
  for (const f of found) {
    const dbPath = path.join(f.dir, DB_BASENAME);
    const problem = verifyBackup(dbPath);
    console.log(`  ${problem ? "✗" : "✓"} ${f.name}  ${f.created_at}${problem ? `  — ${problem}` : ""}`);
  }
  console.log("\nRestore with:  npm run restore -- --latest --yes");
}

function main(): void {
  if (has("--list") || args.length === 0) {
    list();
    if (args.length === 0) console.log("\n(no action taken — pass --latest or a path, with --yes)");
    return;
  }

  const positional = args.find((a) => !a.startsWith("--"));
  let snapshotDir: string | undefined;

  if (has("--latest")) {
    snapshotDir = listBackups(BACKUP_DIR)[0]?.dir;
    if (!snapshotDir) throw new Error(`No snapshots found in ${BACKUP_DIR}`);
  } else if (positional) {
    snapshotDir = path.resolve(positional);
  } else {
    throw new Error("Pass --latest or the path to a snapshot directory (or --list).");
  }

  const backupDb = existsSync(path.join(snapshotDir, DB_BASENAME))
    ? path.join(snapshotDir, DB_BASENAME)
    : snapshotDir; // allow pointing straight at a .db

  const problem = verifyBackup(backupDb);
  if (problem) throw new Error(`That snapshot is not usable: ${problem}`);

  if (!has("--yes")) {
    console.log(`Would restore:\n  from ${backupDb}\n  over ${DB_PATH}\n`);
    console.log("This REPLACES the current books. Stop the app first, then re-run with --yes.");
    return;
  }

  const outcome = restoreBackup(backupDb, DB_PATH, new Date().toISOString());
  console.log(`✓ Restored from ${outcome.restored_from}`);
  if (outcome.previous_saved_to) {
    console.log(`  The replaced book is kept at ${outcome.previous_saved_to}`);
    console.log("  Delete it once you have confirmed the restore is correct.");
  }
  console.log("\nStart the app and check the trial balance before entering anything new.");
}

try {
  main();
} catch (err) {
  console.error(`✗ Restore FAILED: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}
