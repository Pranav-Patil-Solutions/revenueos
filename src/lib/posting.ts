import type Database from "better-sqlite3";
import {
  isInterState,
  splitCgstSgst,
  splitExclusive,
  splitInclusive,
} from "./tax/india-gst";
import { assertNotLocked } from "./vouchers";
import type {
  DocumentRow,
  DraftRowInput,
  PartyRow,
  SettingsRow,
  StagedRow,
} from "./types";

/**
 * Posting engine — staged review rows → immutable double-entry journals.
 *
 * Balance is enforced in three layers: assertBalanced() on every journal's
 * legs before any insert (a throw rolls back the whole transaction), the SQL
 * CHECK that every line is strictly one-sided, and trialBalance() asserting
 * the books sum to zero.
 *
 * v1 is post-only: no void/reverse. Corrections are fix-forward — post a
 * manual opposite entry.
 */

const ACC = {
  cash: "1000",
  bank: "1100",
  ar: "1200",
  itc: "1300",
  ap: "2100",
  cgst: "2200",
  sgst: "2210",
  igst: "2220",
  openingEquity: "3000",
  sales: "4000",
  purchases: "5000",
} as const;

export interface Leg {
  accountCode: string;
  partyId: number | null;
  debitPaise: number;
  creditPaise: number;
}

function leg(
  accountCode: string,
  side: "dr" | "cr",
  paise: number,
  partyId: number | null = null
): Leg {
  return {
    accountCode,
    partyId,
    debitPaise: side === "dr" ? paise : 0,
    creditPaise: side === "cr" ? paise : 0,
  };
}

export function assertBalanced(legs: Leg[]): void {
  let dr = 0;
  let cr = 0;
  for (const l of legs) {
    if (!Number.isInteger(l.debitPaise) || !Number.isInteger(l.creditPaise)) {
      throw new Error("journal leg has non-integer paise");
    }
    if (l.debitPaise < 0 || l.creditPaise < 0) {
      throw new Error("journal leg has a negative amount");
    }
    dr += l.debitPaise;
    cr += l.creditPaise;
  }
  if (dr !== cr) {
    throw new Error(`journal does not balance: Dr ${dr} ≠ Cr ${cr} paise`);
  }
}

type PostableRow = Pick<
  StagedRow,
  | "row_no"
  | "entry_type"
  | "debit_paise"
  | "credit_paise"
  | "gst_rate"
  | "settle_account"
>;
type PartyLike = Pick<PartyRow, "id" | "kind" | "state_code">;
type SettingsLike = Pick<
  SettingsRow,
  "state_code" | "default_gst_rate" | "tax_inclusive"
>;

function taxSplit(G: number, rate: number, settings: SettingsLike) {
  return settings.tax_inclusive === 1
    ? splitInclusive(G, rate)
    : splitExclusive(G, rate);
}

/** CGST+SGST intra-state, IGST inter-state; zero-amount legs are dropped so
 * every emitted leg satisfies the one-sided SQL CHECK. */
function outputTaxLegs(
  taxPaise: number,
  interState: boolean,
  side: "dr" | "cr"
): Leg[] {
  if (taxPaise <= 0) return [];
  if (interState) return [leg(ACC.igst, side, taxPaise)];
  const { cgstPaise, sgstPaise } = splitCgstSgst(taxPaise);
  const legs: Leg[] = [];
  if (cgstPaise > 0) legs.push(leg(ACC.cgst, side, cgstPaise));
  if (sgstPaise > 0) legs.push(leg(ACC.sgst, side, sgstPaise));
  return legs;
}

/** Double-entry legs for one staged row. G is the row's single non-zero
 * column; the entry_type decides which accounts move and in which direction. */
export function buildLegs(
  row: PostableRow,
  party: PartyLike,
  settings: SettingsLike
): Leg[] {
  const debit = row.debit_paise ?? 0;
  const credit = row.credit_paise ?? 0;
  if ((debit === 0) === (credit === 0)) {
    throw new Error(
      `row ${row.row_no}: needs exactly one non-zero side to post`
    );
  }
  const G = debit > 0 ? debit : credit;
  const rate = row.gst_rate ?? settings.default_gst_rate;
  const interState = isInterState(party.state_code, settings.state_code);
  const settle = row.settle_account === "bank" ? ACC.bank : ACC.cash;

  switch (row.entry_type) {
    case "sale": {
      const s = taxSplit(G, rate, settings);
      return [
        leg(ACC.ar, "dr", s.grossPaise, party.id),
        leg(ACC.sales, "cr", s.taxablePaise),
        ...outputTaxLegs(s.taxPaise, interState, "cr"),
      ];
    }
    case "credit_note": {
      // Exact reverse of sale.
      const s = taxSplit(G, rate, settings);
      return [
        leg(ACC.ar, "cr", s.grossPaise, party.id),
        leg(ACC.sales, "dr", s.taxablePaise),
        ...outputTaxLegs(s.taxPaise, interState, "dr"),
      ];
    }
    case "receipt":
      return [leg(settle, "dr", G), leg(ACC.ar, "cr", G, party.id)];
    case "purchase": {
      const s = taxSplit(G, rate, settings);
      const legs = [leg(ACC.purchases, "dr", s.taxablePaise)];
      if (s.taxPaise > 0) legs.push(leg(ACC.itc, "dr", s.taxPaise));
      legs.push(leg(ACC.ap, "cr", s.grossPaise, party.id));
      return legs;
    }
    case "debit_note": {
      // Exact reverse of purchase.
      const s = taxSplit(G, rate, settings);
      const legs = [leg(ACC.ap, "dr", s.grossPaise, party.id)];
      legs.push(leg(ACC.purchases, "cr", s.taxablePaise));
      if (s.taxPaise > 0) legs.push(leg(ACC.itc, "cr", s.taxPaise));
      return legs;
    }
    case "payment":
      return [leg(ACC.ap, "dr", G, party.id), leg(settle, "cr", G)];
    case "opening": {
      // Control account by party kind; direction by which ledger column held
      // the amount; contra to Opening Balance Equity.
      const control = party.kind === "customer" ? ACC.ar : ACC.ap;
      const side: "dr" | "cr" = debit > 0 ? "dr" : "cr";
      const contra: "dr" | "cr" = debit > 0 ? "cr" : "dr";
      return [
        leg(control, side, G, party.id),
        leg(ACC.openingEquity, contra, G),
      ];
    }
    case "other":
      throw new Error(
        `row ${row.row_no}: type 'other' is unpostable — reclassify it or exclude it from posting`
      );
  }
}

/** Persist review-grid edits onto staged rows. No status checks here — both
 * callers guard: the draft action rejects posted docs, postDocument re-checks
 * inside its transaction. */
export function applyDraftRows(
  db: Database.Database,
  docId: number,
  rows: DraftRowInput[]
): void {
  const update = db.prepare(
    `UPDATE staged_rows SET
       entry_date = ?, particulars = ?, ref_no = ?, debit_paise = ?, credit_paise = ?,
       entry_type = ?, gst_rate = ?, settle_account = ?, include = ?
     WHERE id = ? AND document_id = ?`
  );
  for (const r of rows) {
    update.run(
      r.entry_date,
      r.particulars,
      r.ref_no,
      r.debit_paise,
      r.credit_paise,
      r.entry_type,
      r.gst_rate,
      r.settle_account,
      r.include ? 1 : 0,
      r.id,
      docId
    );
  }
}

/**
 * Save the edited rows and post every included one — ONE transaction, one
 * journal per included row. Re-checks doc.status === 'extracted' inside the
 * transaction so a double-click can't post twice. Any failure (unbalanced
 * legs, missing date, an included 'other' row, SQL CHECK) rolls back
 * everything including the status flip.
 */
export function postDocument(
  db: Database.Database,
  docId: number,
  rows: DraftRowInput[]
): { journals: number } {
  const tx = db.transaction((): number => {
    const doc = db
      .prepare("SELECT * FROM documents WHERE id = ?")
      .get(docId) as DocumentRow | undefined;
    if (!doc) throw new Error("Document not found.");
    if (doc.status !== "extracted") {
      throw new Error(
        doc.status === "posted"
          ? "Document is already posted."
          : `Document is '${doc.status}' — only reviewed (extracted) documents can be posted.`
      );
    }
    // Imports can carry a party per staged row (row.party_id); NULL falls back
    // to the document's party, so the photo path is untouched.
    const getParty = db.prepare("SELECT * FROM parties WHERE id = ?");
    const partyCache = new Map<number, PartyRow>();
    const partyFor = (partyId: number): PartyRow => {
      let p = partyCache.get(partyId);
      if (!p) {
        p = getParty.get(partyId) as PartyRow | undefined;
        if (!p) throw new Error(`party ${partyId} not found`);
        partyCache.set(partyId, p);
      }
      return p;
    };
    const settings = db
      .prepare("SELECT * FROM settings WHERE id = 1")
      .get() as SettingsRow;
    const accounts = db
      .prepare("SELECT id, code FROM accounts")
      .all() as { id: number; code: string }[];
    const accountId = new Map(accounts.map((a) => [a.code, a.id]));

    applyDraftRows(db, docId, rows);

    const staged = db
      .prepare(
        "SELECT * FROM staged_rows WHERE document_id = ? ORDER BY row_no"
      )
      .all(docId) as StagedRow[];
    const included = staged.filter((r) => r.include === 1);
    if (included.length === 0) {
      throw new Error("No rows are included — nothing to post.");
    }

    const insertJournal = db.prepare(
      `INSERT INTO journals (entry_date, entry_type, memo, ref_no, source_document_id, source_row_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    const insertLine = db.prepare(
      `INSERT INTO journal_lines (journal_id, line_no, account_id, party_id, debit_paise, credit_paise)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    const stampRow = db.prepare(
      "UPDATE staged_rows SET posted_journal_id = ? WHERE id = ?"
    );
    const now = new Date().toISOString();

    for (const row of included) {
      if (!row.entry_date) {
        throw new Error(`row ${row.row_no}: needs a date before posting`);
      }
      assertNotLocked(db, row.entry_date);
      const legs = buildLegs(row, partyFor(row.party_id ?? doc.party_id), settings);
      assertBalanced(legs);
      const journalId = insertJournal.run(
        row.entry_date,
        row.entry_type,
        row.particulars,
        row.ref_no,
        docId,
        row.id,
        now
      ).lastInsertRowid as number;
      legs.forEach((l, i) => {
        const acc = accountId.get(l.accountCode);
        if (!acc) throw new Error(`unknown account code ${l.accountCode}`);
        insertLine.run(journalId, i + 1, acc, l.partyId, l.debitPaise, l.creditPaise);
      });
      stampRow.run(journalId, row.id);
    }

    db.prepare(
      "UPDATE documents SET status = 'posted', posted_at = ? WHERE id = ?"
    ).run(now, docId);
    return included.length;
  });
  return { journals: tx() };
}
