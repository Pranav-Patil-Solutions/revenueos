import type Database from "better-sqlite3";
import type { CompanyRow, EntityType } from "./types";

/**
 * Company management — RVOS-004 P3.
 *
 * `companies` is a GLOBAL table (see book.ts: it names the tenants, it isn't
 * tenant data), so these functions legitimately query it directly rather than
 * through the Book handle — there is no company_id to bind, the row's own
 * `id` IS the company identity.
 *
 * Archive-only: deleting a client's books is not an action this app exposes
 * behind a button (RVOS-004-SPEC P3). Every mutation here checks it is
 * touching an ACTIVE (non-archived) company first, so an archived company
 * cannot be quietly revived by a rename.
 */

export interface NewCompanyInput {
  name: string;
  entityType?: EntityType;
  pan?: string;
  tan?: string;
  gstin?: string;
  stateCode?: string;
}

export function listCompanies(
  db: Database.Database,
  opts: { includeArchived?: boolean } = {}
): CompanyRow[] {
  const sql = opts.includeArchived
    ? "SELECT * FROM companies ORDER BY (archived_at IS NOT NULL), name COLLATE NOCASE"
    : "SELECT * FROM companies WHERE archived_at IS NULL ORDER BY name COLLATE NOCASE";
  return db.prepare(sql).all() as CompanyRow[];
}

export function getCompany(db: Database.Database, id: number): CompanyRow | undefined {
  return db.prepare("SELECT * FROM companies WHERE id = @id").get({ id }) as
    | CompanyRow
    | undefined;
}

/** Create a client's company row. Does NOT seed a chart of accounts or any
 * book data — that is P4's onboarding flow, layered on top of this. */
export function createCompany(
  db: Database.Database,
  input: NewCompanyInput,
  now: string
): number {
  const name = input.name.trim();
  if (!name) throw new Error("Company name is required.");
  const info = db
    .prepare(
      `INSERT INTO companies
         (name, company_name, entity_type, pan, tan, gstin, state_code, created_at)
       VALUES (@name, @name, @entityType, @pan, @tan, @gstin, @stateCode, @now)`
    )
    .run({
      name,
      entityType: input.entityType ?? "proprietorship",
      pan: (input.pan ?? "").trim().toUpperCase(),
      tan: (input.tan ?? "").trim().toUpperCase(),
      gstin: (input.gstin ?? "").trim().toUpperCase(),
      stateCode: (input.stateCode ?? "").trim(),
      now,
    });
  return Number(info.lastInsertRowid);
}

export function renameCompany(db: Database.Database, id: number, name: string): void {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Company name is required.");
  const info = db
    .prepare(
      `UPDATE companies SET name = @name, company_name = @name
        WHERE id = @id AND archived_at IS NULL`
    )
    .run({ name: trimmed, id });
  if (info.changes === 0) throw new Error("No such active company.");
}

export function archiveCompany(db: Database.Database, id: number, now: string): void {
  const info = db
    .prepare(`UPDATE companies SET archived_at = @now WHERE id = @id AND archived_at IS NULL`)
    .run({ id, now });
  if (info.changes === 0) throw new Error("No such active company.");
}
