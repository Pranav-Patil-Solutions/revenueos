import { strict as assert } from "node:assert";
import { test } from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { SCOPED_TABLES } from "../src/lib/book";

/**
 * Tenancy ratchet — RVOS-004 P2.
 *
 * `company_id` now exists on every book-bearing table, but almost nothing uses
 * it yet: 28 files still call `db.prepare` directly on scoped tables and so
 * read across every client. Porting them is P2's fan-out work.
 *
 * Until that finishes there is a window where a NEW query could be written the
 * old way and nobody would notice — and the eventual "no raw prepare" test
 * cannot be switched on yet because it would fail 28 times over. So this is a
 * ratchet: the offending set may only ever SHRINK.
 *
 * Three assertions, each earning its place:
 *   - no file outside the baseline may start doing this (catches new code)
 *   - the count may not grow (catches a port that quietly regresses)
 *   - the baseline may not go stale (a ported file must be struck off, so the
 *     list keeps telling the truth about how much work is left)
 *
 * When BASELINE reaches zero, delete this file and replace it with a flat
 * assertion that the offending set is empty.
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
]);

/**
 * Files still querying scoped tables directly. STRIKE ENTRIES OFF as they are
 * ported to the Book handle — never add to this list.
 */
const BASELINE: string[] = [
  "src/app/api/import/excel/route.ts",
  "src/app/api/import/tally/preview/route.ts",
  "src/app/api/upload/route.ts",
  "src/app/api/uploads/[id]/route.ts",
  "src/app/capture/page.tsx",
  "src/app/documents/[id]/page.tsx",
  "src/app/documents/page.tsx",
  "src/app/imports/page.tsx",
  "src/app/pack/page.tsx",
  "src/app/page.tsx",
  "src/app/parties/page.tsx",
  "src/app/reports/gst/page.tsx",
  "src/app/settings/accounts/page.tsx",
  "src/app/settings/page.tsx",
  "src/app/tax/computation/page.tsx",
  "src/app/tax/depreciation/page.tsx",
  "src/app/tax/tds/page.tsx",
  "src/app/vouchers/page.tsx",
  "src/lib/actions.ts",
  "src/lib/compliance.ts",
  "src/lib/extraction.ts",
  "src/lib/fy.ts",
  "src/lib/posting.ts",
  "src/lib/reports.ts",
  "src/lib/tax/computation.ts",
  "src/lib/tax/depreciation.ts",
  "src/lib/tax/tds.ts",
  "src/lib/vouchers.ts",
];

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

test("no NEW file queries a scoped table without the Book handle", () => {
  const current = offenders();
  const added = current.filter((f) => !BASELINE.includes(f));
  assert.deepEqual(
    added,
    [],
    `these files query company-scoped tables directly and are not in the baseline: ${added.join(", ")}. ` +
      `Use the Book handle (src/lib/book.ts) — it binds company_id and refuses a query that omits it.`
  );
});

test("the number of unported files never grows", () => {
  const current = offenders();
  assert.ok(
    current.length <= BASELINE.length,
    `unported files went from ${BASELINE.length} to ${current.length} — tenancy scoping is going backwards`
  );
});

test("the baseline does not go stale — ported files must be struck off", () => {
  // Otherwise the list stops telling the truth about how much work is left,
  // and the ratchet silently loosens.
  const current = offenders();
  const fixedButStillListed = BASELINE.filter((f) => !current.includes(f));
  assert.deepEqual(
    fixedButStillListed,
    [],
    `these no longer query scoped tables directly and should be removed from BASELINE: ${fixedButStillListed.join(", ")}`
  );
});

test("progress is visible", () => {
  // Not a pass/fail so much as a number that shows up in every test run, so
  // "how far through P2 are we" never needs someone to go and count.
  const remaining = offenders().length;
  assert.ok(remaining >= 0);
  console.log(`    tenancy: ${BASELINE.length - remaining}/${BASELINE.length} files ported to the Book handle`);
});
