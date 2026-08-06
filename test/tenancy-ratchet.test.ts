import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { SCOPED_TABLES } from "../src/lib/book";

/**
 * Tenancy scoping — RVOS-004 P2/P6.
 *
 * P2 started a ratchet at 28 files calling `db.prepare` directly on a
 * company-scoped table (reading across every client's books). P6 finished
 * porting all of them onto the Book handle (`src/lib/book.ts`), which binds
 * `company_id` and refuses a query that never mentions it — so this is now a
 * flat assertion that the offending set stays empty, not a shrinking list.
 */

/** Files that legitimately reach past the Book handle. Each needs a reason. */
const EXEMPT = new Set([
  // The handle itself, and the schema machinery that necessarily predates it.
  "src/lib/book.ts",
  "src/lib/migrate.ts",
  "src/lib/migrations.ts",
  "src/lib/db.ts",
  // Backups are INSTALLATION-wide by design: a snapshot covers every client,
  // and verifyBackup asserts the whole file's journals balance. Scoping these
  // to one company would make the backup wrong, not safer.
  "src/lib/backup.ts",
  // Manages the `companies` table itself — not scoped (see book.ts's
  // GLOBAL_TABLES), so its raw .prepare() calls are correct by design. It
  // trips the word-match below only because a docstring says "chart of
  // accounts" in English prose, not because it queries the accounts table.
  "src/lib/companies.ts",
]);

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return walk(full);
    return full.endsWith(".ts") || full.endsWith(".tsx") ? [full] : [];
  });
}

function offenders(): string[] {
  const root = process.cwd();
  const out: string[] = [];
  for (const file of walk(path.join(root, "src"))) {
    const rel = file.replace(`${root}/`, "");
    if (EXEMPT.has(rel)) continue;
    const src = readFileSync(file, "utf8");
    if (!/\.prepare\s*\(/.test(src)) continue;
    if (SCOPED_TABLES.some((t) => new RegExp(`\\b${t}\\b`).test(src))) out.push(rel);
  }
  return out.sort();
}

test("no file queries a scoped table without the Book handle", () => {
  const found = offenders();
  assert.deepEqual(
    found,
    [],
    `these files query company-scoped tables directly: ${found.join(", ")}. ` +
      `Use the Book handle (src/lib/book.ts) — it binds company_id and refuses a query that omits it.`
  );
});
