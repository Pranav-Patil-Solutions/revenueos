import { getBankAccount } from "./bank-accounts";
import type { Book } from "./book";
import { getCompany } from "./companies";
import {
  isInterState,
  splitCgstSgst,
  splitExclusive,
  splitInclusive,
} from "./tax/india-gst";
import { assertNotLocked } from "./vouchers";
import type {
  CompanyRow,
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

/**
 * The account codes the posting engine moves. Exported so importers classify
 * ledgers against the same codes this engine posts to — one source of truth.
 *
 * `cash` and `bank` are the SEEDED defaults only. Since RVOS-006 P0a a book may
 * hold any number of cash/bank/wallet accounts, each with its own code, and a
 * settlement's actual code is resolved per row from `bank_account_id`. Do not
 * treat these two as "the" cash and bank ledgers.
 */
export const ACC = {
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
  "row_no" | "entry_type" | "debit_paise" | "credit_paise" | "gst_rate"
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

/**
 * Double-entry legs for one staged row. G is the row's single non-zero column;
 * the entry_type decides which accounts move and in which direction.
 *
 * `settleCode` is the chart-of-accounts code money moves through for the
 * settlement kinds (receipt/payment), resolved by the caller from the row's
 * `bank_account_id` — RVOS-006 P0a. It is passed in rather than looked up here
 * so this function stays pure and unit-testable, which is how the tax-split
 * arithmetic has always been verified.
 */
export function buildLegs(
  row: PostableRow,
  party: PartyLike,
  settings: SettingsLike,
  settleCode: string
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
  const settle = settleCode;

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

/**
 * Persist review-grid edits onto staged rows. No status checks here — both
 * callers guard: the draft action rejects posted docs, postDocument re-checks
 * inside its transaction.
 *
 * `bank_account_id` ownership IS checked here, for every row, whether or not
 * it is included — `saveDraft` (a plain edit, never posts) would otherwise
 * accept and persist any positive integer a form payload supplies, including
 * another company's account id, with nothing to catch it until someone later
 * tried to post that row through `postDocument`'s scoped lookup. A draft is
 * still untrusted input the moment it is written, not only at posting time.
 * Archived accounts ARE accepted (see `postDocument`'s settleCodeFor) — this
 * is an ownership check, not the "must be active" one `resolveSettleCode`
 * applies for a fresh posting choice.
 */
export function applyDraftRows(
  book: Book,
  docId: number,
  rows: DraftRowInput[]
): void {
  for (const r of rows) {
    if (!getBankAccount(book, r.bank_account_id)) {
      throw new Error(
        `row ${r.id}: that bank/cash account is not in this book.`
      );
    }
    book.run(
      `UPDATE staged_rows SET
         entry_date = @entry_date, particulars = @particulars, ref_no = @ref_no,
         debit_paise = @debit_paise, credit_paise = @credit_paise,
         entry_type = @entry_type, gst_rate = @gst_rate, bank_account_id = @bank_account_id,
         include = @include
       WHERE id = @id AND document_id = @docId AND company_id = @company_id`,
      {
        entry_date: r.entry_date,
        particulars: r.particulars,
        ref_no: r.ref_no,
        debit_paise: r.debit_paise,
        credit_paise: r.credit_paise,
        entry_type: r.entry_type,
        gst_rate: r.gst_rate,
        bank_account_id: r.bank_account_id,
        include: r.include ? 1 : 0,
        id: r.id,
        docId,
      }
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
  book: Book,
  docId: number,
  rows: DraftRowInput[]
): { journals: number } {
  return book.tx((b): { journals: number } => {
    const doc = b.get(
      "SELECT * FROM documents WHERE id = @docId AND company_id = @company_id",
      { docId }
    ) as DocumentRow | undefined;
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
    const partyCache = new Map<number, PartyRow>();
    const partyFor = (partyId: number): PartyRow => {
      let p = partyCache.get(partyId);
      if (!p) {
        p = b.get(
          "SELECT * FROM parties WHERE id = @partyId AND company_id = @company_id",
          { partyId }
        ) as PartyRow | undefined;
        if (!p) throw new Error(`party ${partyId} not found`);
        partyCache.set(partyId, p);
      }
      return p;
    };
    const settings = getCompany(b.db, b.companyId) as CompanyRow;
    const accounts = b.all(
      "SELECT id, code FROM accounts WHERE company_id = @company_id"
    ) as { id: number; code: string }[];
    const accountId = new Map(accounts.map((a) => [a.code, a.id]));

    // bank_account_id → its ledger code, once for the whole document rather
    // than per row. Archived accounts ARE resolved here on purpose: archiving
    // means "stop offering this for new entries", not "this ledger is closed to
    // history", and refusing would strand an already-reviewed document whose
    // account was archived in between with no accounting gain.
    const settleCodes = new Map(
      (
        b.all(
          `SELECT ba.id, a.code FROM bank_accounts ba
           JOIN accounts a ON a.id = ba.account_id AND a.company_id = @company_id
           WHERE ba.company_id = @company_id`
        ) as { id: number; code: string }[]
      ).map((r) => [r.id, r.code])
    );
    const settleCodeFor = (row: StagedRow): string => {
      const code = settleCodes.get(row.bank_account_id);
      if (!code) {
        throw new Error(
          `row ${row.row_no}: bank/cash account ${row.bank_account_id} is not in this book`
        );
      }
      return code;
    };

    applyDraftRows(b, docId, rows);

    const staged = b.all(
      "SELECT * FROM staged_rows WHERE document_id = @docId AND company_id = @company_id ORDER BY row_no",
      { docId }
    ) as StagedRow[];
    const included = staged.filter((r) => r.include === 1);
    if (included.length === 0) {
      throw new Error("No rows are included — nothing to post.");
    }

    const now = new Date().toISOString();

    for (const row of included) {
      if (!row.entry_date) {
        throw new Error(`row ${row.row_no}: needs a date before posting`);
      }
      assertNotLocked(b, row.entry_date);
      const legs = buildLegs(
        row,
        partyFor(row.party_id ?? doc.party_id),
        settings,
        settleCodeFor(row)
      );
      assertBalanced(legs);
      const journalId = b.run(
        `INSERT INTO journals
           (company_id, entry_date, entry_type, memo, ref_no, source_document_id, source_row_id, created_at)
         VALUES (@company_id, @entry_date, @entry_type, @memo, @ref_no, @docId, @rowId, @now)`,
        {
          entry_date: row.entry_date,
          entry_type: row.entry_type,
          memo: row.particulars,
          ref_no: row.ref_no,
          docId,
          rowId: row.id,
          now,
        }
      ).lastInsertRowid as number;
      legs.forEach((l, i) => {
        const acc = accountId.get(l.accountCode);
        if (!acc) throw new Error(`unknown account code ${l.accountCode}`);
        b.run(
          `INSERT INTO journal_lines
             (company_id, journal_id, line_no, account_id, party_id, debit_paise, credit_paise)
           VALUES (@company_id, @journalId, @lineNo, @accountId, @partyId, @debitPaise, @creditPaise)`,
          {
            journalId,
            lineNo: i + 1,
            accountId: acc,
            partyId: l.partyId,
            debitPaise: l.debitPaise,
            creditPaise: l.creditPaise,
          }
        );
      });
      b.run(
        "UPDATE staged_rows SET posted_journal_id = @journalId WHERE id = @rowId AND company_id = @company_id",
        { journalId, rowId: row.id }
      );
    }

    b.run(
      "UPDATE documents SET status = 'posted', posted_at = @now WHERE id = @docId AND company_id = @company_id",
      { now, docId }
    );
    return { journals: included.length };
  });
}
