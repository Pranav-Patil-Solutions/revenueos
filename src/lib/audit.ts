import type { Book } from "./book";
import type { AuditLogRow } from "./types";

/**
 * The audit trail — RVOS-006 P0b.
 *
 * `audit_log` is append-only at the SQL level (migration 005 installs triggers
 * that ABORT any UPDATE or DELETE), so this module only ever inserts. There is
 * deliberately no `editAudit` or `deleteAudit` to import.
 *
 * ── What belongs in here ──
 * Actions whose EFFECT someone may later have to account for: posting to the
 * books, locking a period, changing a client's tax identity, adding or
 * archiving an account, changing who has access. Not page views, and not
 * reads — a log that records everything is one nobody reads.
 *
 * ── Why the snapshots are JSON strings ──
 * `before_json` / `after_json` hold whatever the changed row looked like, not a
 * typed diff. A typed diff would have to be migrated in lockstep with every
 * table it can describe; a JSON snapshot of the row as it was stays readable
 * years later even after the table's shape has moved on, which is exactly the
 * horizon an audit trail is for.
 */

export interface AuditEntry {
  action: string;
  entity: string;
  entity_id?: number | null;
  summary: string;
  before?: unknown;
  after?: unknown;
}

/**
 * Append one row. Call INSIDE the transaction that makes the change, so the
 * record and the change commit or roll back together — a log entry for a
 * change that was rolled back is a lie, and a change with no log entry is the
 * gap the log exists to close.
 */
export function writeAudit(book: Book, entry: AuditEntry, now: string): void {
  book.run(
    `INSERT INTO audit_log
       (company_id, actor_user_id, action, entity, entity_id, summary,
        before_json, after_json, created_at)
     VALUES (@company_id, @actor, @action, @entity, @entityId, @summary,
             @before, @after, @now)`,
    {
      actor: book.actorUserId,
      action: entry.action,
      entity: entry.entity,
      entityId: entry.entity_id ?? null,
      summary: entry.summary,
      before: entry.before === undefined ? null : JSON.stringify(entry.before),
      after: entry.after === undefined ? null : JSON.stringify(entry.after),
      now,
    }
  );
}

export interface AuditLogEntryWithActor extends AuditLogRow {
  /** NULL actor renders as "unknown", never as a guessed name. */
  actor_username: string | null;
}

/** Most recent first. `limit` is capped so a huge log cannot be asked for in
 * one page. */
export function recentAudit(book: Book, limit = 100): AuditLogEntryWithActor[] {
  const capped = Math.max(1, Math.min(limit, 500));
  return book.all(
    `SELECT al.*, u.username AS actor_username
     FROM audit_log al
     LEFT JOIN auth_users u ON u.id = al.actor_user_id
     WHERE al.company_id = @company_id
     ORDER BY al.created_at DESC, al.id DESC
     LIMIT ${capped}`
  ) as AuditLogEntryWithActor[];
}
