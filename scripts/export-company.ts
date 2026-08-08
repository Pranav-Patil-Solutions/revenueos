/**
 * Export ONE company's own books into a standalone database — RVOS-004 P5.
 *
 * For the day a client asks for their own books, or moves to their own CA.
 * `npm run backup` protects the WHOLE office (every client at once, simplest
 * and safest for disaster recovery); this produces a handoff file containing
 * exactly one company's data and nothing else — see src/lib/backup.ts's
 * exportCompany() for what is and is not copied, and why.
 *
 *   npm run export:company -- --list          # which companies exist
 *   npm run export:company -- 2                # export company id 2
 *   REVENUEOS_EXPORT_DIR=~/Desktop npm run export:company -- 2
 *
 * Safe to run while the app is serving — reads are through the live
 * connection, read-only, same as `npm run backup`.
 */
import path from "node:path";
import Database from "better-sqlite3";
import { exportCompany } from "../src/lib/backup";

const DATA_DIR = path.join(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "revenueos.db");
const EXPORT_DIR = process.env.REVENUEOS_EXPORT_DIR ?? path.join(DATA_DIR, "exports");

function list(db: Database.Database): void {
  const companies = db
    .prepare(
      "SELECT id, name, archived_at FROM companies ORDER BY (archived_at IS NOT NULL), name COLLATE NOCASE"
    )
    .all() as { id: number; name: string; archived_at: string | null }[];
  if (!companies.length) {
    console.log("No companies found.");
    return;
  }
  console.log(`${companies.length} compan${companies.length === 1 ? "y" : "ies"}:\n`);
  for (const c of companies) {
    console.log(`  ${c.id}  ${c.name}${c.archived_at ? "  (archived)" : ""}`);
  }
  console.log("\nExport one with:  npm run export:company -- <id>");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  try {
    if (args.includes("--list") || args.length === 0) {
      list(db);
      return;
    }

    const companyId = Number(args[0]);
    if (!Number.isInteger(companyId) || companyId < 1) {
      throw new Error(`"${args[0]}" is not a valid company id. Try --list.`);
    }

    const now = new Date().toISOString();
    const result = await exportCompany(db, companyId, EXPORT_DIR, now, process.cwd());

    const mb = (result.bytes / 1024 / 1024).toFixed(2);
    console.log(`✓ ${result.dir}`);
    console.log(`  ${mb} MB · sha256 ${result.sha256.slice(0, 16)}…`);
    console.log(
      `  rows: ${Object.entries(result.row_counts)
        .filter(([, n]) => n > 0)
        .map(([t, n]) => `${t} ${n}`)
        .join(" · ")}`
    );
    if (result.uploads_expected > 0) {
      console.log(`  ${result.uploads_copied}/${result.uploads_expected} ledger photo(s) copied`);
      if (result.uploads_copied < result.uploads_expected) {
        console.log("  ⚠ some referenced uploads were missing on disk — see the count above");
      }
    }
    console.log(
      "\nThis file is a real SQLite database at the current schema, verified to contain\n" +
        "ONLY this company's data. It contains no staff logins (auth is per-installation,\n" +
        "not per-client) — safe to hand to the client's own accountant."
    );
  } finally {
    db.close();
  }
}

main().catch((err) => {
  console.error(`\n✗ Export FAILED: ${err instanceof Error ? err.message : err}\n`);
  process.exit(1);
});
