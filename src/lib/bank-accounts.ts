import type { Book } from "./book";
import type { BankAccountKind, BankAccountRow, SettleHint } from "./types";

/**
 * Bank, cash, wallet and card accounts — RVOS-006 P0a.
 *
 * ── Why this table exists ──
 * Until now "where the money moved" was a two-value enum, `settle_account
 * TEXT CHECK (settle_account IN ('cash','bank'))`, hardcoded across 58 call
 * sites and mapped to exactly two chart-of-accounts codes (1000 Cash, 1100
 * Bank) by `posting.ts`. A business with a current account, an OD account and
 * a UPI wallet could not keep books in this app at all: every bank movement
 * landed on one undifferentiated "Bank" ledger, so no bank reconciliation
 * could ever be performed against a real statement, and the balance sheet
 * showed one number where the office has three.
 *
 * That was a defect, not a missing feature, which is why it is fixed BEFORE
 * the order layer and the aging reports rather than after: every phase that
 * follows writes to this column, and the cost of the change is proportional
 * to how much code has already been written against the enum.
 *
 * ── The hint seam (important) ──
 * Ingestion cannot know WHICH bank account a khata line refers to. A
 * photographed ledger says "By Bank NEFT"; a shopkeeper filling the CSV
 * template writes "bank"; a Tally voucher names a ledger this book may not
 * have mapped yet. So ingestion keeps producing a coarse `SettleHint`
 * ('cash' | 'bank') and this module RESOLVES that hint to the company's
 * default account of that kind at staging time. The human then corrects it in
 * the review grid, where they can see the actual account list.
 *
 * The alternative — asking the extraction model to pick an account id — would
 * have it inventing precision it cannot have.
 *
 * `wallet` and `card` are deliberately NOT hint targets: nothing upstream can
 * distinguish them from a bank movement, so they are chosen by a human or not
 * at all.
 */

/** Chart-of-accounts code ranges, by kind. Cash-like accounts live in
 * 1000–1099 and bank-like in 1100–1199, which is where the seeded Cash (1000)
 * and Bank (1100) already sit — so an existing book keeps its codes and every
 * report, export and backup taken before this phase still lines up. */
const CODE_RANGES: Record<BankAccountKind, { lo: number; hi: number }> = {
  cash: { lo: 1000, hi: 1099 },
  bank: { lo: 1100, hi: 1199 },
  wallet: { lo: 1100, hi: 1199 },
  card: { lo: 1100, hi: 1199 },
};

/** Which kind a coarse ingestion hint resolves to. */
export const KIND_FOR_HINT: Record<SettleHint, BankAccountKind> = {
  cash: "cash",
  bank: "bank",
};

export interface BankAccountWithCode extends BankAccountRow {
  account_code: string;
  account_name: string;
}

/** Every account for this book, defaults first then by name. Archived ones are
 * excluded unless asked for — they stay selectable nowhere but remain in the
 * books, because journals already point at them. */
export function listBankAccounts(
  book: Book,
  opts: { includeArchived?: boolean } = {}
): BankAccountWithCode[] {
  return book.all(
    `SELECT ba.*, a.code AS account_code, a.name AS account_name
     FROM bank_accounts ba
     JOIN accounts a ON a.id = ba.account_id AND a.company_id = @company_id
     WHERE ba.company_id = @company_id
       AND (@includeArchived = 1 OR ba.archived_at IS NULL)
     ORDER BY ba.is_default DESC, ba.kind, ba.name`,
    { includeArchived: opts.includeArchived ? 1 : 0 }
  ) as BankAccountWithCode[];
}

export function getBankAccount(
  book: Book,
  id: number
): BankAccountWithCode | undefined {
  return book.get(
    `SELECT ba.*, a.code AS account_code, a.name AS account_name
     FROM bank_accounts ba
     JOIN accounts a ON a.id = ba.account_id AND a.company_id = @company_id
     WHERE ba.company_id = @company_id AND ba.id = @id`,
    { id }
  ) as BankAccountWithCode | undefined;
}

/**
 * The account an ingestion hint means. Throws rather than inventing one: a
 * book with no cash account cannot stage a cash receipt, and silently posting
 * it to the bank would move money through an account the source document never
 * mentioned — the same reasoning `import-tally.ts` already applies when it
 * refuses to assume cash.
 */
export function defaultForHint(book: Book, hint: SettleHint): BankAccountWithCode {
  const kind = KIND_FOR_HINT[hint];
  const row = book.get(
    `SELECT ba.*, a.code AS account_code, a.name AS account_name
     FROM bank_accounts ba
     JOIN accounts a ON a.id = ba.account_id AND a.company_id = @company_id
     WHERE ba.company_id = @company_id AND ba.kind = @kind
       AND ba.archived_at IS NULL
     ORDER BY ba.is_default DESC, ba.id
     LIMIT 1`,
    { kind }
  ) as BankAccountWithCode | undefined;
  if (!row) {
    throw new Error(
      `This book has no ${kind} account, so a "${hint}" entry cannot be staged. ` +
        `Add one under Settings → Bank & cash accounts first.`
    );
  }
  return row;
}

/**
 * The chart-of-accounts code a settlement posts to. Validates ownership on the
 * way through — a bank_account_id arriving from a form is untrusted input, and
 * the Book handle scopes the lookup, so a cross-company id resolves to nothing
 * rather than to another client's ledger.
 */
export function resolveSettleCode(book: Book, bankAccountId: number): string {
  const row = book.get(
    `SELECT a.code, ba.archived_at, ba.name
     FROM bank_accounts ba
     JOIN accounts a ON a.id = ba.account_id AND a.company_id = @company_id
     WHERE ba.company_id = @company_id AND ba.id = @id`,
    { id: bankAccountId }
  ) as { code: string; archived_at: string | null; name: string } | undefined;
  if (!row) throw new Error("That bank/cash account does not exist in this book.");
  if (row.archived_at) {
    throw new Error(
      `"${row.name}" is archived — pick an active account, or post a dated ` +
        `correction against the account that is still open.`
    );
  }
  return row.code;
}

/** Smallest free code in the kind's range, preferring round tens (1010, 1020…)
 * so a hand-read chart of accounts stays legible, then falling back to any
 * free integer once the tens are used up. */
function allocateCode(book: Book, kind: BankAccountKind): string {
  const { lo, hi } = CODE_RANGES[kind];
  const taken = new Set(
    (
      book.all(
        `SELECT code FROM accounts
         WHERE company_id = @company_id AND CAST(code AS INTEGER) BETWEEN @lo AND @hi`,
        { lo, hi }
      ) as { code: string }[]
    ).map((r) => r.code)
  );
  for (let c = lo + 10; c <= hi; c += 10) {
    if (!taken.has(String(c))) return String(c);
  }
  for (let c = lo; c <= hi; c += 1) {
    if (!taken.has(String(c))) return String(c);
  }
  throw new Error(
    `No chart-of-accounts code is free in the ${kind} range ${lo}–${hi}. ` +
      `Archive an unused account first.`
  );
}

export interface NewBankAccount {
  name: string;
  kind: BankAccountKind;
  account_no?: string;
  ifsc?: string;
  is_default?: boolean;
}

/**
 * Create an account and the chart-of-accounts ledger behind it, in ONE
 * transaction. Its own ledger is the point: two bank accounts sharing one
 * ledger cannot be reconciled separately, which is the whole reason this phase
 * exists.
 */
export function createBankAccount(book: Book, input: NewBankAccount): number {
  const name = input.name.trim();
  if (!name) throw new Error("The account needs a name.");
  return book.tx((b) => {
    const code = allocateCode(b, input.kind);
    const accountId = b.run(
      `INSERT INTO accounts (company_id, code, name, type, group_code)
       VALUES (@company_id, @code, @name, 'asset', 'current_assets')`,
      { code, name }
    ).lastInsertRowid as number;

    const existing = b.get(
      `SELECT COUNT(*) AS n FROM bank_accounts
       WHERE company_id = @company_id AND kind = @kind AND archived_at IS NULL`,
      { kind: input.kind }
    ) as { n: number };
    // First account of a kind is its default whether or not the caller asked:
    // hint resolution needs one, and "no default" is not a state worth having.
    const isDefault = input.is_default || existing.n === 0;
    if (isDefault) clearDefault(b, input.kind);

    const id = b.run(
      `INSERT INTO bank_accounts
         (company_id, name, kind, account_id, account_no, ifsc, is_default, archived_at, created_at)
       VALUES (@company_id, @name, @kind, @accountId, @account_no, @ifsc, @isDefault, NULL, @now)`,
      {
        name,
        kind: input.kind,
        accountId,
        account_no: (input.account_no ?? "").trim(),
        ifsc: (input.ifsc ?? "").trim().toUpperCase(),
        isDefault: isDefault ? 1 : 0,
        now: new Date().toISOString(),
      }
    ).lastInsertRowid as number;
    return Number(id);
  });
}

function clearDefault(book: Book, kind: BankAccountKind): void {
  book.run(
    `UPDATE bank_accounts SET is_default = 0
     WHERE company_id = @company_id AND kind = @kind AND is_default = 1`,
    { kind }
  );
}

/** Renames both the account and the ledger behind it — they are one thing to
 * the office, and a chart of accounts reading "Bank" beside an account called
 * "HDFC current" is how a book stops being trustworthy. */
export function renameBankAccount(book: Book, id: number, name: string): void {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("The account needs a name.");
  book.tx((b) => {
    const row = b.get(
      "SELECT account_id FROM bank_accounts WHERE company_id = @company_id AND id = @id",
      { id }
    ) as { account_id: number } | undefined;
    if (!row) throw new Error("That bank/cash account does not exist in this book.");
    b.run(
      "UPDATE bank_accounts SET name = @name WHERE company_id = @company_id AND id = @id",
      { id, name: trimmed }
    );
    b.run(
      "UPDATE accounts SET name = @name WHERE company_id = @company_id AND id = @accountId",
      { accountId: row.account_id, name: trimmed }
    );
  });
}

export function setDefaultBankAccount(book: Book, id: number): void {
  book.tx((b) => {
    const row = b.get(
      `SELECT kind, archived_at FROM bank_accounts
       WHERE company_id = @company_id AND id = @id`,
      { id }
    ) as { kind: BankAccountKind; archived_at: string | null } | undefined;
    if (!row) throw new Error("That bank/cash account does not exist in this book.");
    if (row.archived_at) {
      throw new Error("An archived account cannot be the default.");
    }
    clearDefault(b, row.kind);
    b.run(
      "UPDATE bank_accounts SET is_default = 1 WHERE company_id = @company_id AND id = @id",
      { id }
    );
  });
}

/**
 * Archive, never delete — the house rule (see companies.ts). Journals already
 * point at the ledger behind this account and deleting it would orphan them.
 *
 * Refused in one case: the last active account of its kind, because
 * `defaultForHint` would then have nothing to resolve a staged 'cash' or
 * 'bank' row to, and every subsequent import would fail at staging time
 * instead of here, where the cause is obvious.
 */
export function archiveBankAccount(book: Book, id: number, now: string): void {
  book.tx((b) => {
    const row = b.get(
      `SELECT kind, is_default, archived_at, name FROM bank_accounts
       WHERE company_id = @company_id AND id = @id`,
      { id }
    ) as
      | { kind: BankAccountKind; is_default: number; archived_at: string | null; name: string }
      | undefined;
    if (!row) throw new Error("That bank/cash account does not exist in this book.");
    if (row.archived_at) return; // already archived — idempotent

    const siblings = b.all(
      `SELECT id FROM bank_accounts
       WHERE company_id = @company_id AND kind = @kind
         AND archived_at IS NULL AND id <> @id`,
      { kind: row.kind, id }
    ) as { id: number }[];
    if (siblings.length === 0) {
      throw new Error(
        `"${row.name}" is this book's only ${row.kind} account. Add another ` +
          `before archiving it, or entries of that kind could not be staged.`
      );
    }
    b.run(
      `UPDATE bank_accounts SET archived_at = @now, is_default = 0
       WHERE company_id = @company_id AND id = @id`,
      { id, now }
    );
    // The default moved with the archive, so hand it to a sibling rather than
    // leaving the kind default-less.
    if (row.is_default === 1) {
      b.run(
        "UPDATE bank_accounts SET is_default = 1 WHERE company_id = @company_id AND id = @sibling",
        { sibling: siblings[0].id }
      );
    }
  });
}
