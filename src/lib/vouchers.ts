import { resolveSettleCode } from "./bank-accounts";
import type { Book } from "./book";
import { getCompany } from "./companies";
import { assertBalanced, buildLegs, type Leg } from "./posting";
import { roundHalfUp } from "./tax/india-gst";
import { computeTds, type TdsComputation } from "./tax/tds";
import type {
  CompanyRow,
  JournalKind,
  PartyRow,
  SettingsRow,
  StagedRow,
} from "./types";

/**
 * Manual vouchers — first-class journals with no source document
 * (source_document_id NULL). Structured kinds reuse buildLegs() so a manual
 * sale posts exactly like a captured one; contra moves cash↔bank; free-form
 * journal takes explicit legs. Same balance guards as document posting.
 */

/** Structured voucher kinds — the six khata entry types posted via buildLegs. */
export type StructuredKind =
  | "sale"
  | "purchase"
  | "receipt"
  | "payment"
  | "credit_note"
  | "debit_note";

export interface StructuredVoucherInput {
  kind: StructuredKind;
  entry_date: string;
  memo: string;
  ref_no: string;
  party_id: number;
  amount_paise: number; // gross (ledger column) amount
  gst_rate: number | null;
  bank_account_id: number;
}

/** Contra moves money between two of the book's own accounts — since RVOS-006
 * P0a that includes bank→bank transfers, not just cash↔bank. */
export interface ContraVoucherInput {
  kind: "contra";
  entry_date: string;
  memo: string;
  ref_no: string;
  from_bank_account_id: number;
  to_bank_account_id: number;
  amount_paise: number;
}

export interface JournalLegInput {
  account_code: string;
  party_id: number | null;
  debit_paise: number;
  credit_paise: number;
}

export interface JournalVoucherInput {
  kind: "journal";
  entry_date: string;
  memo: string;
  ref_no: string;
  legs: JournalLegInput[];
  /** Stamped onto journals.entry_type instead of "journal" — lets a generated
   * entry (depreciation, TDS challan) stay identifiable in the day book while
   * still posting through the one audited journal path. journals.entry_type
   * has no CHECK; the frozen 8-value enum is staged_rows only. */
  entry_type?: JournalKind;
}

export type VoucherInput =
  | StructuredVoucherInput
  | ContraVoucherInput
  | JournalVoucherInput;


/** Soft books lock: entries on or before settings.books_locked_through are
 * refused (fix-forward still applies after the lock date). */
export function assertNotLocked(book: Book, entryDate: string): void {
  const s = getCompany(book.db, book.companyId) as
    | Pick<SettingsRow, "books_locked_through">
    | undefined;
  const locked = s?.books_locked_through ?? "";
  if (locked !== "" && entryDate <= locked) {
    throw new Error(
      `Books are locked through ${locked} — entries dated ${entryDate} cannot be posted. ` +
        `Post a current-dated correction instead.`
    );
  }
}

function assertDate(entryDate: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(entryDate)) {
    throw new Error("Voucher needs a date (YYYY-MM-DD).");
  }
}

function assertAmount(paise: number): void {
  if (!Number.isInteger(paise) || paise <= 0) {
    throw new Error("Voucher amount must be a positive integer of paise.");
  }
}

/** Legs for one voucher input. Exported for tests — pure given db lookups. */
function legsFor(book: Book, input: VoucherInput): Leg[] {
  switch (input.kind) {
    case "contra": {
      assertAmount(input.amount_paise);
      if (input.from_bank_account_id === input.to_bank_account_id) {
        throw new Error("A contra needs two different accounts.");
      }
      return [
        {
          accountCode: resolveSettleCode(book, input.to_bank_account_id),
          partyId: null,
          debitPaise: input.amount_paise,
          creditPaise: 0,
        },
        {
          accountCode: resolveSettleCode(book, input.from_bank_account_id),
          partyId: null,
          debitPaise: 0,
          creditPaise: input.amount_paise,
        },
      ];
    }
    case "journal": {
      if (input.legs.length < 2) {
        throw new Error("A journal needs at least two legs.");
      }
      const codes = new Set(
        (
          book.all(
            "SELECT code FROM accounts WHERE company_id = @company_id"
          ) as { code: string }[]
        ).map((a) => a.code)
      );
      return input.legs.map((l, i) => {
        const label = `leg ${i + 1}`;
        if (!codes.has(l.account_code)) {
          throw new Error(`${label}: unknown account code ${l.account_code}`);
        }
        if (
          !Number.isInteger(l.debit_paise) ||
          !Number.isInteger(l.credit_paise) ||
          l.debit_paise < 0 ||
          l.credit_paise < 0
        ) {
          throw new Error(`${label}: amounts must be non-negative integer paise`);
        }
        if ((l.debit_paise === 0) === (l.credit_paise === 0)) {
          throw new Error(`${label}: needs exactly one non-zero side`);
        }
        return {
          accountCode: l.account_code,
          partyId: l.party_id,
          debitPaise: l.debit_paise,
          creditPaise: l.credit_paise,
        };
      });
    }
    default: {
      assertAmount(input.amount_paise);
      const party = book.get(
        "SELECT * FROM parties WHERE id = @partyId AND company_id = @company_id",
        { partyId: input.party_id }
      ) as PartyRow | undefined;
      if (!party) throw new Error("Voucher party not found.");
      // AR kinds need a customer, AP kinds a supplier — the form filters its
      // options, but the server must hold on a direct call too.
      const expectedKind =
        input.kind === "sale" ||
        input.kind === "receipt" ||
        input.kind === "credit_note"
          ? "customer"
          : "supplier";
      if (party.kind !== expectedKind) {
        throw new Error(
          `A ${input.kind.replace("_", " ")} voucher needs a ${expectedKind}; ` +
            `"${party.name}" is a ${party.kind}.`
        );
      }
      const settings = getCompany(book.db, book.companyId) as CompanyRow;
      const row: Pick<
        StagedRow,
        "row_no" | "entry_type" | "debit_paise" | "credit_paise" | "gst_rate"
      > = {
        row_no: 0,
        entry_type: input.kind,
        debit_paise: input.amount_paise,
        credit_paise: null,
        gst_rate: input.gst_rate,
      };
      return buildLegs(
        row,
        party,
        settings,
        resolveSettleCode(book, input.bank_account_id)
      );
    }
  }
}

/**
 * Post one manual voucher — ONE transaction: lock guard, leg construction,
 * assertBalanced, journal + lines insert. Any throw rolls back everything.
 */
export function postManualVoucher(
  book: Book,
  input: VoucherInput
): { journalId: number } {
  return book.tx((b): { journalId: number } => {
    assertDate(input.entry_date);
    assertNotLocked(b, input.entry_date);
    const legs = legsFor(b, input);
    assertBalanced(legs);

    const accounts = b.all(
      "SELECT id, code FROM accounts WHERE company_id = @company_id"
    ) as { id: number; code: string }[];
    const accountId = new Map(accounts.map((a) => [a.code, a.id]));

    const journalId = b.run(
      `INSERT INTO journals
         (company_id, entry_date, entry_type, memo, ref_no, source_document_id, source_row_id, created_at)
       VALUES (@company_id, @entry_date, @entry_type, @memo, @ref_no, NULL, NULL, @now)`,
      {
        entry_date: input.entry_date,
        entry_type: input.kind === "journal" ? input.entry_type ?? input.kind : input.kind,
        memo: input.memo,
        ref_no: input.ref_no,
        now: new Date().toISOString(),
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
    return { journalId };
  });
}

// ---------------------------------------------------------------------------
// TDS at the point of payment
// ---------------------------------------------------------------------------

export interface TdsVoucherInput {
  entry_date: string;
  memo: string;
  ref_no: string;
  /** The payee. Their PAN (or its absence) sets the rate. */
  party_id: number;
  /** What the payment is for, e.g. "5900" expenses. */
  expense_account_code: string;
  /** The gross bill, before deduction. */
  base_paise: number;
  section: string;
  use_alt?: boolean;
  /** Which of the book's accounts the net payment leaves from. */
  bank_account_id: number;
  /** For sections with no standard rate (salary), the office's own figure.
   * Ignored otherwise. */
  tds_paise_override?: number | null;
}

/**
 * Pay a bill net of TDS: ONE journal splitting the gross three ways, plus the
 * register row that points at it — written in a single transaction so the
 * books and the register can never disagree. A ₹10,000 contractor bill at 1%
 * paid by bank posts Dr 5900 ₹10,000 / Cr 2300 ₹100 / Cr Bank ₹9,900.
 *
 * If the register insert fails for any reason the journal goes with it. That
 * is the point of the transaction: a deduction claimed on a return must have
 * a book entry behind it, and a book entry crediting 2300 must be traceable
 * to a payee on a return.
 */
export function postVoucherWithTds(
  book: Book,
  input: TdsVoucherInput
): { journalId: number; tdsEntryId: number; computation: TdsComputation } {
  return book.tx((b) => {
    assertDate(input.entry_date);
    assertNotLocked(b, input.entry_date);
    if (!Number.isInteger(input.base_paise) || input.base_paise <= 0) {
      throw new Error("The bill amount must be a positive amount in paise.");
    }

    const party = b.get(
      "SELECT * FROM parties WHERE id = @partyId AND company_id = @company_id",
      { partyId: input.party_id }
    ) as PartyRow | undefined;
    if (!party) throw new Error("Payee not found.");

    const computation = computeTds(
      input.base_paise,
      input.section,
      party.pan.trim() !== "",
      input.use_alt ?? false
    );

    let tdsPaise = computation.tds_paise;
    if (input.tds_paise_override !== null && input.tds_paise_override !== undefined) {
      if (
        !Number.isInteger(input.tds_paise_override) ||
        input.tds_paise_override < 0 ||
        input.tds_paise_override > input.base_paise
      ) {
        throw new Error(
          "The TDS amount must be a whole number of paise between zero and the bill."
        );
      }
      tdsPaise = input.tds_paise_override;
    }
    // The register's rate must describe what was actually deducted — an
    // override at a different amount stores its EFFECTIVE rate, not the
    // section default it didn't use (audit trail, not decoration).
    const rateBp =
      tdsPaise === computation.tds_paise
        ? computation.bp
        : roundHalfUp((tdsPaise * 10_000) / input.base_paise);

    const settleCode = resolveSettleCode(b, input.bank_account_id);
    const legs: Leg[] = [
      {
        accountCode: input.expense_account_code,
        partyId: null,
        debitPaise: input.base_paise,
        creditPaise: 0,
      },
    ];
    if (tdsPaise > 0) {
      legs.push({
        accountCode: "2300",
        partyId: null,
        debitPaise: 0,
        creditPaise: tdsPaise,
      });
    }
    const net = input.base_paise - tdsPaise;
    if (net > 0) {
      legs.push({
        accountCode: settleCode,
        partyId: null,
        debitPaise: 0,
        creditPaise: net,
      });
    }
    assertBalanced(legs);

    const accounts = b.all(
      "SELECT id, code FROM accounts WHERE company_id = @company_id"
    ) as { id: number; code: string }[];
    const accountId = new Map(accounts.map((a) => [a.code, a.id]));
    const now = new Date().toISOString();

    const journalId = b.run(
      `INSERT INTO journals
         (company_id, entry_date, entry_type, memo, ref_no, source_document_id, source_row_id, created_at)
       VALUES (@company_id, @entry_date, 'tds_deduction', @memo, @ref_no, NULL, NULL, @now)`,
      { entry_date: input.entry_date, memo: input.memo, ref_no: input.ref_no, now }
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

    const tdsEntryId = b.run(
      `INSERT INTO tds_entries
         (company_id, party_id, section, entry_date, base_paise, tds_paise, rate_bp, journal_id, challan_id, created_at)
       VALUES (@company_id, @partyId, @section, @entry_date, @basePaise, @tdsPaise, @rateBp, @journalId, NULL, @now)`,
      {
        partyId: input.party_id,
        section: computation.section,
        entry_date: input.entry_date,
        basePaise: input.base_paise,
        tdsPaise,
        rateBp,
        journalId,
        now,
      }
    ).lastInsertRowid as number;

    return { journalId, tdsEntryId: Number(tdsEntryId), computation };
  });
}
