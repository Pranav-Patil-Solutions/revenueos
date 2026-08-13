import type Database from "better-sqlite3";

/**
 * The Book handle — RVOS-004 P2.
 *
 * One client's books, and only that client's. Every query in this app must go
 * through here once P2 completes.
 *
 * ── Why a handle, and why it REFUSES rather than helps ──
 * The obvious design is a helper that binds `company_id` for you. That is not
 * enough: it still lets someone write `SELECT * FROM journals`, forget the
 * WHERE clause, and get every client's rows. The failure is silent, it looks
 * like a working report, and it is discovered by a client seeing another
 * client's turnover.
 *
 * So this handle does two things:
 *   1. binds `@company_id` automatically, so nobody has to pass it, and
 *   2. THROWS AT QUERY TIME if a statement touches a company-scoped table
 *      without mentioning `company_id` at all.
 *
 * (2) is the point. It converts "someone forgot" from a silent data leak into
 * a loud failure on the first run — in a test, in dev, long before it reaches
 * an office. A guard you can forget to use is a guard that will be forgotten;
 * this one cannot be, because the query simply does not run.
 *
 * It is deliberately a TEXT check rather than a SQL parser. A parser is more
 * precise and much more code, and the text check has the property that
 * matters: it has no false negatives on the failure we care about — a query
 * naming a scoped table but never naming `company_id` cannot be correct.
 */

/** Tables that carry `company_id` after migration 001. */
export const SCOPED_TABLES = [
  "accounts",
  "parties",
  "documents",
  "staged_rows",
  "journals",
  "journal_lines",
  "tds_entries",
  "tds_challans",
  "it_adjustments",
  "tax_payments",
  "fixed_assets",
  "wdv_openings",
  "compliance_marks",
  "ledger_mappings",
  "bank_accounts",
  "audit_log",
  "cost_centres",
] as const;

export type ScopedTable = (typeof SCOPED_TABLES)[number];

/** Tables that are deliberately global — no company_id, and never should have
 * one. Firm staff and the migration ledger belong to the installation, not to
 * a client. */
export const GLOBAL_TABLES = [
  "auth_users",
  "auth_sessions",
  "schema_version",
  "companies",
  "settings",
] as const;

/** Strip comments and string literals so a table name inside a quoted string
 * or a comment cannot trip the check. */
function normalise(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/'(?:[^']|'')*'/g, " '' ")
    .toLowerCase();
}

/** Which scoped tables a statement touches. */
export function scopedTablesIn(sql: string): ScopedTable[] {
  const text = normalise(sql);
  return SCOPED_TABLES.filter((t) => new RegExp(`\\b${t}\\b`).test(text));
}

/**
 * Returns a description of the problem, or null when the statement is safe.
 * Exported so the static scoping test can use the identical rule rather than
 * re-implementing it and drifting.
 */
export function scopingProblem(sql: string): string | null {
  const touched = scopedTablesIn(sql);
  if (touched.length === 0) return null;
  if (/\bcompany_id\b/.test(normalise(sql))) return null;
  return (
    `This statement reads or writes ${touched.join(", ")} without mentioning ` +
    `company_id, so it would cross every client's books. Add ` +
    `"company_id = @company_id" (the Book handle binds it for you).`
  );
}

export interface Book {
  readonly companyId: number;
  /**
   * The signed-in user this handle is acting for, stamped onto
   * `journals.created_by` and `audit_log.actor_user_id` (RVOS-006 P0b).
   *
   * Carried on the handle rather than passed to each posting function so that
   * attribution cannot be forgotten at a call site: `requireBook()` builds the
   * handle from the session, which already knows who is asking, and every
   * write underneath inherits it.
   *
   * `null` is a real state, not a missing value — a migration, a CLI script or
   * a test has no signed-in user, and recording "unknown" is correct where
   * inventing a name would be fabricating an audit trail.
   */
  readonly actorUserId: number | null;
  /** The raw connection, for the few places that legitimately need it —
   * migrations, backups, and global tables. Using it for a scoped table is a
   * bug the static test will catch. */
  readonly db: Database.Database;
  all<T = unknown>(sql: string, params?: Record<string, unknown>): T[];
  get<T = unknown>(sql: string, params?: Record<string, unknown>): T | undefined;
  run(sql: string, params?: Record<string, unknown>): Database.RunResult;
  /** Run several statements atomically, still scoped. */
  tx<T>(fn: (book: Book) => T): T;
}

export function book(
  db: Database.Database,
  companyId: number,
  actorUserId: number | null = null
): Book {
  if (!Number.isInteger(companyId) || companyId < 1) {
    throw new Error(`Invalid company id: ${String(companyId)}`);
  }

  const guard = (sql: string): void => {
    const problem = scopingProblem(sql);
    if (problem) throw new Error(problem);
  };

  const bind = (params?: Record<string, unknown>) => ({ ...params, company_id: companyId });

  const handle: Book = {
    companyId,
    actorUserId,
    db,
    all<T>(sql: string, params?: Record<string, unknown>): T[] {
      guard(sql);
      return db.prepare(sql).all(bind(params)) as T[];
    },
    get<T>(sql: string, params?: Record<string, unknown>): T | undefined {
      guard(sql);
      return db.prepare(sql).get(bind(params)) as T | undefined;
    },
    run(sql: string, params?: Record<string, unknown>): Database.RunResult {
      guard(sql);
      return db.prepare(sql).run(bind(params));
    },
    tx<T>(fn: (b: Book) => T): T {
      return db.transaction(() => fn(handle))();
    },
  };
  return handle;
}

/** The company a book belongs to must exist and not be archived. Callers that
 * resolve a company from a session should use this rather than trusting an id. */
export function assertUsableCompany(db: Database.Database, companyId: number): void {
  const row = db
    .prepare("SELECT id, archived_at FROM companies WHERE id = @id")
    .get({ id: companyId }) as { id: number; archived_at: string | null } | undefined;
  if (!row) throw new Error(`No such company: ${companyId}`);
  if (row.archived_at) throw new Error(`Company ${companyId} is archived`);
}
