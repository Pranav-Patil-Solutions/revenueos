import type Database from "better-sqlite3";
import { assertBalanced, buildLegs, type Leg } from "./posting";
import type {
  PartyRow,
  SettingsRow,
  SettleAccount,
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
  settle_account: SettleAccount;
}

export interface ContraVoucherInput {
  kind: "contra";
  entry_date: string;
  memo: string;
  ref_no: string;
  from: SettleAccount;
  to: SettleAccount;
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
}

export type VoucherInput =
  | StructuredVoucherInput
  | ContraVoucherInput
  | JournalVoucherInput;

const SETTLE: Record<SettleAccount, string> = { cash: "1000", bank: "1100" };

/** Soft books lock: entries on or before settings.books_locked_through are
 * refused (fix-forward still applies after the lock date). */
export function assertNotLocked(
  db: Database.Database,
  entryDate: string
): void {
  const s = db
    .prepare("SELECT books_locked_through FROM settings WHERE id = 1")
    .get() as Pick<SettingsRow, "books_locked_through"> | undefined;
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
function legsFor(db: Database.Database, input: VoucherInput): Leg[] {
  switch (input.kind) {
    case "contra": {
      assertAmount(input.amount_paise);
      if (input.from === input.to) {
        throw new Error("Contra needs two different accounts (cash ↔ bank).");
      }
      return [
        {
          accountCode: SETTLE[input.to],
          partyId: null,
          debitPaise: input.amount_paise,
          creditPaise: 0,
        },
        {
          accountCode: SETTLE[input.from],
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
        (db.prepare("SELECT code FROM accounts").all() as { code: string }[]).map(
          (a) => a.code
        )
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
      const party = db
        .prepare("SELECT * FROM parties WHERE id = ?")
        .get(input.party_id) as PartyRow | undefined;
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
      const settings = db
        .prepare("SELECT * FROM settings WHERE id = 1")
        .get() as SettingsRow;
      const row: Pick<
        StagedRow,
        | "row_no"
        | "entry_type"
        | "debit_paise"
        | "credit_paise"
        | "gst_rate"
        | "settle_account"
      > = {
        row_no: 0,
        entry_type: input.kind,
        debit_paise: input.amount_paise,
        credit_paise: null,
        gst_rate: input.gst_rate,
        settle_account: input.settle_account,
      };
      return buildLegs(row, party, settings);
    }
  }
}

/**
 * Post one manual voucher — ONE transaction: lock guard, leg construction,
 * assertBalanced, journal + lines insert. Any throw rolls back everything.
 */
export function postManualVoucher(
  db: Database.Database,
  input: VoucherInput
): { journalId: number } {
  const tx = db.transaction((): number => {
    assertDate(input.entry_date);
    assertNotLocked(db, input.entry_date);
    const legs = legsFor(db, input);
    assertBalanced(legs);

    const accounts = db
      .prepare("SELECT id, code FROM accounts")
      .all() as { id: number; code: string }[];
    const accountId = new Map(accounts.map((a) => [a.code, a.id]));

    const journalId = db
      .prepare(
        `INSERT INTO journals (entry_date, entry_type, memo, ref_no, source_document_id, source_row_id, created_at)
         VALUES (?, ?, ?, ?, NULL, NULL, ?)`
      )
      .run(
        input.entry_date,
        input.kind,
        input.memo,
        input.ref_no,
        new Date().toISOString()
      ).lastInsertRowid as number;

    const insertLine = db.prepare(
      `INSERT INTO journal_lines (journal_id, line_no, account_id, party_id, debit_paise, credit_paise)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    legs.forEach((l, i) => {
      const acc = accountId.get(l.accountCode);
      if (!acc) throw new Error(`unknown account code ${l.accountCode}`);
      insertLine.run(journalId, i + 1, acc, l.partyId, l.debitPaise, l.creditPaise);
    });
    return journalId;
  });
  return { journalId: tx() };
}
