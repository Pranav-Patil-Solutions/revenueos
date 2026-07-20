import { XMLParser } from "fast-xml-parser";
import { rupeeStringToPaise } from "./format";
import { ACC } from "./posting";
import { GST_RATES, splitExclusive, splitInclusive } from "./tax/india-gst";
import type { ImportRow } from "./import-csv";
import type {
  AccountType,
  EntryType,
  LedgerTargetKind,
  SettleAccount,
} from "./types";

/**
 * Tally-path import: a Day Book exported as XML becomes staged rows in the
 * SAME review flow as a photo extraction or a CSV import. Nothing posts from
 * here — review remains the only gate.
 *
 * Two ideas carry the whole file:
 *
 * 1. Tally books at the LEDGER level; RevenueOS stages at the VOUCHER level
 *    (one staged row → one journal, with buildLegs deriving the account legs
 *    from entry_type + GST). So each voucher collapses to one row keyed on its
 *    single party ledger, and vouchers that cannot collapse that way land
 *    include=0 with a reason instead of being silently reshaped.
 *
 * 2. Ledger names are mapped to this book's accounts/parties ONCE and the
 *    mapping persists (ledger_mappings), so the second import of the same
 *    book asks nothing.
 *
 * Tally's sign convention: AMOUNT is negative for a debit, positive for a
 * credit. Every voucher's ledger entries sum to zero — we assert that rather
 * than trusting ISDEEMEDPOSITIVE, which some exports omit.
 */

/** Amounts MUST stay strings — parseTagValue:true would hand us
 * -11800.00 as a float and the integer-paise invariant dies at the door.
 * rupeeStringToPaise does the digit math instead. */
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  isArray: (name) => ARRAY_TAGS.has(name),
});

const ARRAY_TAGS = new Set([
  "TALLYMESSAGE",
  "VOUCHER",
  "ALLLEDGERENTRIES.LIST",
  "LEDGERENTRIES.LIST",
]);

/** One ledger line inside a Tally voucher. */
export interface TallyEntry {
  ledger_name: string;
  amount_paise: number; // negative = debit, positive = credit (Tally's sign)
}

/** One voucher as it stands in the file, before any mapping is applied. */
export interface TallyVoucher {
  voucher_no: number; // 1-based position in the file — the staged row_no
  entry_date: string | null;
  vch_type: string; // raw VOUCHERTYPENAME / VCHTYPE, for the reason text
  narration: string;
  ref_no: string;
  entries: TallyEntry[];
  problem: string; // "" when the voucher parsed cleanly
}

export interface LedgerMapping {
  ledger_name: string;
  target_kind: LedgerTargetKind;
  account_id: number | null;
  party_id: number | null;
}

export interface MappedAccount {
  id: number;
  code: string;
  type: AccountType;
}

/** Tally voucher type → the frozen 8-value staged enum. Matched on the name
 * lowercased with spaces stripped. Anything else — Journal, Contra, Stock
 * Journal, a user-defined type — is NOT guessed at: it lands excluded with a
 * "post manually via Vouchers" reason. Mis-posting money is worse than making
 * the user retype a row that is already in front of them. */
const VOUCHER_TYPES: Record<string, EntryType> = {
  sales: "sale",
  purchase: "purchase",
  receipt: "receipt",
  payment: "payment",
  creditnote: "credit_note",
  debitnote: "debit_note",
};

/** Which side the party's control account takes for each mapped type — the
 * same direction buildLegs() will post. A Sales voucher whose party ledger is
 * CREDITED is not a sale (it is a return booked oddly, or a mis-typed
 * voucher); posting it would move the receivable the wrong way, so it is
 * excluded rather than reversed silently. */
const PARTY_SIDE: Record<string, "debit" | "credit"> = {
  sale: "debit",
  credit_note: "credit",
  receipt: "credit",
  purchase: "credit",
  debit_note: "debit",
  payment: "debit",
};

const GST_ACCOUNT_CODES = new Set<string>([
  ACC.cgst,
  ACC.sgst,
  ACC.igst,
  ACC.itc,
]);

/** The account type the non-tax side of a trade voucher must carry. buildLegs
 * collapses that side into a single Sales/Purchases posting, which is only
 * faithful when every such leg really is revenue (or cost). A leg of any other
 * type — discount, freight, round-off, TDS receivable, a fixed asset bought on
 * a Purchase voucher — would be folded into revenue/cost and misstate the P&L,
 * so it is refused instead. */
const TRADE_LEG_TYPE: Record<string, AccountType> = {
  sale: "income",
  credit_note: "income",
  purchase: "expense",
  debit_note: "expense",
};

/** Tally writes dates as YYYYMMDD; some exports use ISO. Anything else is a
 * voucher-level problem, never a thrown file-level failure. */
function parseTallyDate(raw: string): string | null {
  const t = raw.trim();
  if (t === "") return null;
  const m = t.match(/^(\d{4})-?(\d{2})-?(\d{2})$/);
  if (!m) throw new Error(`date "${t}" is not a Tally date (YYYYMMDD)`);
  const [, y, mo, d] = m;
  if (Number(mo) < 1 || Number(mo) > 12 || Number(d) < 1 || Number(d) > 31) {
    throw new Error(`date "${t}" is not a real date`);
  }
  return `${y}-${mo}-${d}`;
}

type XmlNode = Record<string, unknown>;

/** Tally's envelope shape varies by export path (IMPORTDATA/REQUESTDATA vs
 * BODY/DATA), so collect VOUCHER nodes at any depth rather than pinning a
 * path that the next export format breaks. */
function collectVouchers(node: unknown, out: XmlNode[]): void {
  if (Array.isArray(node)) {
    for (const child of node) collectVouchers(child, out);
    return;
  }
  if (node === null || typeof node !== "object") return;
  for (const [key, value] of Object.entries(node as XmlNode)) {
    if (key === "VOUCHER") {
      for (const v of Array.isArray(value) ? value : [value]) {
        if (v !== null && typeof v === "object") out.push(v as XmlNode);
      }
      continue;
    }
    collectVouchers(value, out);
  }
}

/** Reads a leaf as text. parseTagValue:false keeps everything a string, but an
 * empty element parses to "" and a nested one to an object — both become "". */
function text(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return "";
}

function entriesOf(v: XmlNode): unknown[] {
  const all = v["ALLLEDGERENTRIES.LIST"] ?? v["LEDGERENTRIES.LIST"];
  if (all === undefined) return [];
  return Array.isArray(all) ? all : [all];
}

/**
 * Day Book XML → vouchers, in file order. Throws only on a file-level problem
 * (unparseable XML, no vouchers at all); a bad voucher carries its own
 * `problem` string and still comes back so review can show it.
 */
export function parseDayBook(xml: string): TallyVoucher[] {
  let tree: unknown;
  try {
    tree = parser.parse(xml);
  } catch (e) {
    throw new Error(
      `That file isn't readable XML — export the Day Book again (${
        e instanceof Error ? e.message : "parse failed"
      }).`
    );
  }
  const nodes: XmlNode[] = [];
  collectVouchers(tree, nodes);
  if (nodes.length === 0) {
    throw new Error(
      "No <VOUCHER> entries in that file — export Day Book → Ctrl+E → XML from Tally."
    );
  }

  return nodes.map((v, i) => {
    const problems: string[] = [];
    let entry_date: string | null = null;
    try {
      entry_date = parseTallyDate(text(v.DATE));
    } catch (e) {
      problems.push(e instanceof Error ? e.message : "bad date");
    }

    const entries: TallyEntry[] = [];
    for (const raw of entriesOf(v)) {
      if (raw === null || typeof raw !== "object") continue;
      const e = raw as XmlNode;
      const ledger_name = text(e.LEDGERNAME).trim();
      const amountRaw = text(e.AMOUNT);
      if (ledger_name === "") {
        problems.push("a ledger entry has no LEDGERNAME");
        continue;
      }
      try {
        entries.push({ ledger_name, amount_paise: rupeeStringToPaise(amountRaw) });
      } catch {
        problems.push(`ledger "${ledger_name}" has an unreadable amount "${amountRaw}"`);
      }
    }

    if (entries.length === 0) {
      problems.push("voucher has no ledger entries");
    } else {
      // Tally vouchers always balance; if these don't, the file was edited or
      // the signs were stripped — either way the amounts can't be trusted.
      const net = entries.reduce((sum, e) => sum + e.amount_paise, 0);
      if (net !== 0) {
        problems.push("ledger entries don't balance — the amounts can't be trusted");
      }
    }

    const vch_type = (text(v.VOUCHERTYPENAME) || text(v["@_VCHTYPE"])).trim();
    return {
      voucher_no: i + 1,
      entry_date,
      vch_type,
      narration: text(v.NARRATION).trim(),
      ref_no: text(v.VOUCHERNUMBER).trim(),
      entries,
      problem: problems.join("; "),
    };
  });
}

/** Ledger names that still need a target, for the mapping form. Only ledgers
 * from vouchers we can actually import are asked about — mapping 40 ledgers
 * off Journal vouchers that land excluded anyway is busywork. */
export function unmappedLedgers(
  vouchers: TallyVoucher[],
  mappings: LedgerMapping[]
): string[] {
  const known = new Set(mappings.map((m) => m.ledger_name.trim().toLowerCase()));
  const out = new Set<string>();
  for (const v of vouchers) {
    if (!VOUCHER_TYPES[normalizeType(v.vch_type)]) continue;
    for (const e of v.entries) {
      if (!known.has(e.ledger_name.toLowerCase())) out.add(e.ledger_name);
    }
  }
  return [...out].sort((a, b) => a.localeCompare(b));
}

function normalizeType(vchType: string): string {
  return vchType.toLowerCase().replace(/\s+/g, "");
}

/** Pre-selection for the mapping form: an exact (case-insensitive) name match
 * on a party or account. A name that matches MORE than one candidate returns
 * nothing — an ambiguous suggestion silently pointing at whichever row came
 * last is exactly the bug EVOLUTION #12 exists to prevent. */
export function suggestTarget(
  ledgerName: string,
  parties: { id: number; name: string }[],
  accounts: { id: number; name: string }[]
): { target_kind: LedgerTargetKind; id: number } | null {
  const key = ledgerName.trim().toLowerCase();
  const party = parties.filter((p) => p.name.trim().toLowerCase() === key);
  const account = accounts.filter((a) => a.name.trim().toLowerCase() === key);
  if (party.length + account.length !== 1) return null;
  return party.length === 1
    ? { target_kind: "party", id: party[0].id }
    : { target_kind: "account", id: account[0].id };
}

/**
 * Infer the GST rate from the tax ledgers Tally already booked, by finding the
 * rate whose split reproduces that tax EXACTLY. Never averages or rounds into
 * a "close enough" rate — an unreconcilable tax comes back null so the row is
 * excluded and a human sets the rate.
 *
 * Returns the rate plus the amount to stage: buildLegs treats the staged
 * amount as gross when the book is tax-inclusive and as taxable when it is
 * not, while Tally's party leg is ALWAYS the gross.
 */
function inferGst(
  grossPaise: number,
  taxPaise: number,
  taxInclusive: boolean
): { rate: number; amount_paise: number } | null {
  if (taxPaise === 0) {
    return { rate: 0, amount_paise: grossPaise };
  }
  for (const rate of GST_RATES) {
    if (rate === 0) continue;
    if (taxInclusive) {
      if (splitInclusive(grossPaise, rate).taxPaise === taxPaise) {
        return { rate, amount_paise: grossPaise };
      }
    } else {
      const taxable = grossPaise - taxPaise;
      const s = splitExclusive(taxable, rate);
      if (s.taxPaise === taxPaise && s.grossPaise === grossPaise) {
        return { rate, amount_paise: taxable };
      }
    }
  }
  return null;
}

export interface TallyConvertOptions {
  taxInclusive: boolean;
}

/**
 * Vouchers + ledger mappings → staged-row shapes, identical in shape to the
 * CSV path so both land through the same insert. Every row that cannot be
 * mapped with certainty comes back include=0 with the reason suffixed onto
 * its particulars — the file is never rejected wholesale.
 */
export function tallyVouchersToRows(
  vouchers: TallyVoucher[],
  mappings: LedgerMapping[],
  accounts: MappedAccount[],
  options: TallyConvertOptions
): { rows: ImportRow[]; included: number; excluded: number } {
  const byLedger = new Map<string, LedgerMapping>();
  for (const m of mappings) byLedger.set(m.ledger_name.trim().toLowerCase(), m);
  const accountById = new Map(accounts.map((a) => [a.id, a]));

  const rows: ImportRow[] = vouchers.map((v) => {
    const problems: string[] = v.problem ? [v.problem] : [];
    const entry_type = VOUCHER_TYPES[normalizeType(v.vch_type)];

    // Classify every leg against the mapping table. Skipped entirely for a
    // voucher type we can't import: unmappedLedgers() never asks about those
    // ledgers, so "not mapped" would be noise on top of the real reason.
    const partyLegs: { entry: TallyEntry; party_id: number }[] = [];
    const accountLegs: { entry: TallyEntry; account: MappedAccount }[] = [];
    for (const e of entry_type ? v.entries : []) {
      const m = byLedger.get(e.ledger_name.toLowerCase());
      if (!m) {
        problems.push(`ledger "${e.ledger_name}" is not mapped`);
        continue;
      }
      if (m.target_kind === "party" && m.party_id !== null) {
        partyLegs.push({ entry: e, party_id: m.party_id });
      } else if (m.target_kind === "account" && m.account_id !== null) {
        const account = accountById.get(m.account_id);
        if (!account) {
          problems.push(`ledger "${e.ledger_name}" maps to an account that no longer exists`);
        } else {
          accountLegs.push({ entry: e, account });
        }
      } else {
        // Unreachable through the db (paired CHECKs guarantee one target), but
        // a leg must never be dropped silently — a dropped leg can make a
        // two-party voucher look like a clean one-party one.
        problems.push(`ledger "${e.ledger_name}" has a broken mapping`);
      }
    }

    let debit_paise: number | null = null;
    let credit_paise: number | null = null;
    let party_id: number | null = null;
    let gst_rate: number | null = null;
    let settle_account: SettleAccount = "cash";

    if (!entry_type) {
      problems.push(
        `voucher type "${v.vch_type || "(none)"}" doesn't map to an entry type — post it manually via Vouchers`
      );
    } else if (partyLegs.length !== 1) {
      problems.push(
        partyLegs.length === 0
          ? "no party ledger in this voucher (a cash sale posts as a sale plus a receipt) — post it manually via Vouchers"
          : `${partyLegs.length} party ledgers in one voucher — post it manually via Vouchers`
      );
    } else {
      const partyLeg = partyLegs[0];
      party_id = partyLeg.party_id;
      const grossPaise = Math.abs(partyLeg.entry.amount_paise);
      const side = partyLeg.entry.amount_paise < 0 ? "debit" : "credit";
      // Tally's party leg is always the gross; inferGst hands back what this
      // book's tax mode actually wants staged (gross, or taxable).
      let stagedAmount = grossPaise;

      if (side !== PARTY_SIDE[entry_type]) {
        problems.push(
          `"${v.vch_type}" with the party ledger ${side}ed posts backwards — post it manually via Vouchers`
        );
      } else if (entry_type === "receipt" || entry_type === "payment") {
        // A settlement moves cash/bank against the party — no tax to infer.
        gst_rate = 0;
        const settleLegs = accountLegs.filter(
          (l) => l.account.code === ACC.bank || l.account.code === ACC.cash
        );
        const extra = accountLegs.length - settleLegs.length;
        if (settleLegs.length === 0) {
          // Never assume cash: buildLegs would move money through an account
          // the voucher never touched.
          problems.push(
            "no cash or bank ledger in this settlement — post it manually via Vouchers"
          );
        } else if (settleLegs.length > 1) {
          problems.push(
            "settles against more than one cash/bank ledger — post it manually via Vouchers"
          );
        } else if (extra > 0) {
          // TDS deducted at source, bank charges, discount — the party leg is
          // the gross, so posting it whole would overstate what reached the bank.
          problems.push(
            `${extra} extra ledger${extra === 1 ? "" : "s"} beyond the settlement (TDS, charges, discount) — post it manually via Vouchers`
          );
        } else {
          settle_account = settleLegs[0].account.code === ACC.bank ? "bank" : "cash";
        }
      } else {
        const taxLegs = accountLegs.filter((l) =>
          GST_ACCOUNT_CODES.has(l.account.code)
        );
        const tradeLegs = accountLegs.filter(
          (l) =>
            !GST_ACCOUNT_CODES.has(l.account.code) &&
            l.account.type === TRADE_LEG_TYPE[entry_type]
        );
        const extra = accountLegs.length - taxLegs.length - tradeLegs.length;
        const taxPaise = taxLegs.reduce(
          (sum, l) => sum + Math.abs(l.entry.amount_paise),
          0
        );
        const gst = inferGst(grossPaise, taxPaise, options.taxInclusive);
        if (tradeLegs.length === 0) {
          problems.push(
            `no ${TRADE_LEG_TYPE[entry_type]} ledger in this voucher — post it manually via Vouchers`
          );
        } else if (extra > 0) {
          problems.push(
            `${extra} extra ledger${extra === 1 ? "" : "s"} beyond ${TRADE_LEG_TYPE[entry_type]} and tax (discount, freight, round-off, a fixed asset) — post it manually via Vouchers`
          );
        } else if (!gst) {
          problems.push(
            `GST of ${taxPaise} paise on ${grossPaise} paise doesn't match a standard rate — set the rate at review`
          );
        } else {
          gst_rate = gst.rate;
          stagedAmount = gst.amount_paise;
        }
      }

      // Staged even on an excluded row, so review shows the size of the entry.
      if (side === "debit") debit_paise = stagedAmount;
      else credit_paise = stagedAmount;
    }

    // No usable party leg: still surface the voucher's size in the grid.
    if (debit_paise === null && credit_paise === null && v.entries.length > 0) {
      const totalDebit = v.entries
        .filter((e) => e.amount_paise < 0)
        .reduce((sum, e) => sum + Math.abs(e.amount_paise), 0);
      if (totalDebit > 0) debit_paise = totalDebit;
    }

    const reason = problems.join("; ");
    const base = v.narration || v.vch_type || "Tally voucher";
    return {
      row_no: v.voucher_no,
      entry_date: v.entry_date,
      particulars: reason ? `${base} — ⚠ ${reason}` : base,
      ref_no: v.ref_no,
      debit_paise,
      credit_paise,
      // 'other' is inside the frozen CHECK and is unpostable by definition —
      // the safe landing spot for anything we refused to classify.
      entry_type: reason ? "other" : entry_type!,
      gst_rate,
      settle_account,
      party_id,
      confidence: reason ? 0.2 : 1,
      include: reason === "",
      reason,
    };
  });

  const included = rows.filter((r) => r.include).length;
  return { rows, included, excluded: rows.length - included };
}
