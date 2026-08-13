import { writeAudit } from "./audit";
import type { Book } from "./book";
import type { CostCentreRow } from "./types";

/**
 * Cost centres — RVOS-006 P0c.
 *
 * ── What this dimension is for ──
 * The ledger can already say what was earned and spent, and with whom. It
 * cannot say WHICH PART OF THE BUSINESS did it. A firm running two shops, or a
 * trading arm beside a service arm, gets one blended P&L and cannot tell which
 * half is carrying the other — which is the question an owner actually asks,
 * and the axis Stage 4's budgets and MIS pack are sliced by.
 *
 * ── Deliberately NOT a second source of truth ──
 * A cost centre is a tag on a journal LINE, never a balance of its own. There
 * is no cost-centre ledger to drift from the accounts: "spend on Shop A" is
 * always re-derived by summing the lines carrying it, so it cannot disagree
 * with the P&L it is a partition of.
 *
 * ── Flat, not a tree ──
 * No parent/child. A hierarchy needs roll-up rules, cycle prevention and a
 * decision about whether a parent may itself be tagged; none of that earns its
 * cost until an office asks for it, and a flat list can grow into a tree later
 * without invalidating any journal already written.
 *
 * ── Archiving is unconditional here, unlike bank accounts ──
 * `archiveBankAccount` refuses to archive the last account of its kind because
 * ingestion MUST resolve a hint to one. Nothing needs to resolve to a cost
 * centre — the column is nullable and NULL is the normal case — so a book with
 * every cost centre archived is a book that stopped using the dimension, which
 * is a legitimate state rather than a broken one.
 */

export interface NewCostCentre {
  name: string;
  /** Optional — derived from the name when blank. */
  code?: string;
}

/** Active first, then by code. Archived ones are excluded unless asked for:
 * they stay out of every picker but remain in the books, because journal lines
 * already point at them. */
export function listCostCentres(
  book: Book,
  opts: { includeArchived?: boolean } = {}
): CostCentreRow[] {
  return book.all(
    `SELECT * FROM cost_centres
     WHERE company_id = @company_id
       AND (@includeArchived = 1 OR archived_at IS NULL)
     ORDER BY archived_at IS NOT NULL, code`,
    { includeArchived: opts.includeArchived ? 1 : 0 }
  ) as CostCentreRow[];
}

export function getCostCentre(book: Book, id: number): CostCentreRow | undefined {
  return book.get(
    "SELECT * FROM cost_centres WHERE company_id = @company_id AND id = @id",
    { id }
  ) as CostCentreRow | undefined;
}

/** How many journal lines carry this centre — shown on the settings page so
 * "archive" is a decision made with the consequence visible, and so the
 * dimension is provably reaching the books at all. */
export function costCentreUsage(book: Book): Map<number, number> {
  const rows = book.all(
    `SELECT cost_centre_id AS id, COUNT(*) AS n
     FROM journal_lines
     WHERE company_id = @company_id AND cost_centre_id IS NOT NULL
     GROUP BY cost_centre_id`
  ) as { id: number; n: number }[];
  return new Map(rows.map((r) => [r.id, r.n]));
}

/** A code from a name: uppercase, spaces and punctuation to hyphens. Only a
 * starting point — the office can type its own. */
export function codeFromName(name: string): string {
  return name
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 16);
}

export function createCostCentre(book: Book, input: NewCostCentre): number {
  const name = input.name.trim();
  if (!name) throw new Error("The cost centre needs a name.");
  const code = (input.code?.trim() ? input.code.trim().toUpperCase() : codeFromName(name))
    .replace(/\s+/g, "-");
  if (!code) {
    throw new Error("The cost centre needs a code — letters or digits, e.g. SHOP-A.");
  }
  const now = new Date().toISOString();
  return book.tx((b) => {
    // Checked before the insert so the office reads a sentence rather than a
    // UNIQUE constraint message — including when the collision is with an
    // ARCHIVED centre, which is still occupying the code.
    const clash = b.get(
      "SELECT name, archived_at FROM cost_centres WHERE company_id = @company_id AND code = @code",
      { code }
    ) as { name: string; archived_at: string | null } | undefined;
    if (clash) {
      throw new Error(
        `The code ${code} is already used by "${clash.name}"` +
          (clash.archived_at ? " (archived)." : ".") +
          " Pick another."
      );
    }
    const id = Number(
      b.run(
        `INSERT INTO cost_centres (company_id, code, name, archived_at, created_at)
         VALUES (@company_id, @code, @name, NULL, @now)`,
        { code, name, now }
      ).lastInsertRowid
    );
    writeAudit(
      b,
      {
        action: "cost_centre.create",
        entity: "cost_centre",
        entity_id: id,
        summary: `Added cost centre ${code} — "${name}"`,
        after: { code, name },
      },
      now
    );
    return id;
  });
}

export function renameCostCentre(book: Book, id: number, name: string): void {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("The cost centre needs a name.");
  book.tx((b) => {
    const row = getCostCentre(b, id);
    if (!row) throw new Error("That cost centre does not exist in this book.");
    b.run(
      "UPDATE cost_centres SET name = @name WHERE company_id = @company_id AND id = @id",
      { id, name: trimmed }
    );
    writeAudit(
      b,
      {
        action: "cost_centre.rename",
        entity: "cost_centre",
        entity_id: id,
        summary: `Renamed cost centre ${row.code} to "${trimmed}"`,
        before: { name: row.name },
        after: { name: trimmed },
      },
      new Date().toISOString()
    );
  });
}

/** Archive, never delete — journal lines already point at it, and a report that
 * cannot name the centre a past line belongs to is worse than one that shows an
 * archived name. */
export function archiveCostCentre(book: Book, id: number, now: string): void {
  book.tx((b) => {
    const row = getCostCentre(b, id);
    if (!row) throw new Error("That cost centre does not exist in this book.");
    if (row.archived_at) return; // idempotent
    b.run(
      "UPDATE cost_centres SET archived_at = @now WHERE company_id = @company_id AND id = @id",
      { id, now }
    );
    writeAudit(
      b,
      {
        action: "cost_centre.archive",
        entity: "cost_centre",
        entity_id: id,
        summary: `Archived cost centre ${row.code} — "${row.name}"`,
        before: { code: row.code, name: row.name, archived_at: null },
        after: { code: row.code, name: row.name, archived_at: now },
      },
      now
    );
  });
}

/**
 * Validate a cost centre chosen NOW, for a fresh entry: it must belong to this
 * book and still be active. Untrusted input — an id off a form payload — so
 * ownership is checked through the Book handle, which scopes the lookup: a
 * cross-company id resolves to nothing rather than to another client's centre.
 *
 * `null` passes through: no cost centre is the normal case, not an omission.
 */
export function resolveCostCentre(book: Book, id: number | null): number | null {
  if (id === null) return null;
  const row = getCostCentre(book, id);
  if (!row) throw new Error("That cost centre does not exist in this book.");
  if (row.archived_at) {
    throw new Error(
      `Cost centre "${row.name}" is archived — pick an active one, or leave it blank.`
    );
  }
  return row.id;
}

/**
 * The laxer check, for an id already SAVED on a staged row: ownership only.
 *
 * The same distinction `posting.ts` draws for bank accounts. Archiving means
 * "stop offering this for new entries", not "history through it is void", so a
 * document reviewed on Monday and posted on Wednesday must not be stranded
 * because its centre was archived on Tuesday — refusing would cost the office a
 * re-review and gain the books nothing.
 */
export function assertOwnedCostCentre(book: Book, id: number | null): number | null {
  if (id === null) return null;
  if (!getCostCentre(book, id)) {
    throw new Error("That cost centre is not in this book.");
  }
  return id;
}
