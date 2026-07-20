import { rupeeStringToPaise } from "./format";
import { GST_RATES } from "./tax/india-gst";
import type { EntryType, SettleAccount } from "./types";

/**
 * Excel-path import: the user fills the CSV template (exported from Excel /
 * Google Sheets) and the rows land in the SAME staged review flow as a photo
 * extraction. Nothing posts from here — review remains the only gate.
 *
 * Bad cells never reject the file: the row lands include=0 with the reason
 * suffixed onto its particulars, so the review table surfaces exactly what to
 * fix. entry_type maps onto the frozen 8-value staged_rows CHECK — never a
 * value outside it.
 */

export const TEMPLATE_HEADERS = [
  "date",
  "particulars",
  "ref_no",
  "party",
  "entry_type",
  "debit",
  "credit",
  "gst_rate",
  "settle_account",
] as const;

const ENTRY_TYPES: EntryType[] = [
  "sale",
  "receipt",
  "purchase",
  "payment",
  "credit_note",
  "debit_note",
  "opening",
  "other",
];

export interface ImportParty {
  id: number;
  name: string;
}

/** One parsed template row, shaped for a staged_rows insert. */
export interface ImportRow {
  row_no: number;
  entry_date: string | null;
  particulars: string;
  ref_no: string;
  debit_paise: number | null;
  credit_paise: number | null;
  entry_type: EntryType;
  gst_rate: number | null;
  settle_account: SettleAccount;
  party_id: number | null; // NULL = the document's default party
  confidence: number;
  include: boolean;
  reason: string; // "" when clean
}

/** RFC-4180 parser — the inverse of toCsv(). Handles quoted cells with
 * embedded commas/quotes/newlines and CRLF line ends. Blank records are
 * dropped. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  let i = 0;
  const pushCell = () => {
    row.push(cell);
    cell = "";
  };
  const pushRow = () => {
    pushCell();
    rows.push(row);
    row = [];
  };
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      cell += c;
      i++;
      continue;
    }
    if (c === '"' && cell === "") {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === ",") {
      pushCell();
      i++;
      continue;
    }
    if (c === "\r") {
      i++;
      if (text[i] === "\n") i++;
      pushRow();
      continue;
    }
    if (c === "\n") {
      pushRow();
      i++;
      continue;
    }
    cell += c;
    i++;
  }
  if (cell !== "" || row.length > 0) pushRow();
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

/** "2026-07-02", "02/07/2026", or "02-07-2026" → ISO. Blank → null. */
function parseTemplateDate(raw: string): string | null {
  const t = raw.trim();
  if (t === "") return null;
  let y: number, mo: number, d: number;
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) {
    [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  } else {
    m = t.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
    if (!m) throw new Error(`date "${t}" must be YYYY-MM-DD or DD/MM/YYYY`);
    [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  }
  if (mo < 1 || mo > 12 || d < 1 || d > 31) {
    throw new Error(`date "${t}" is not a real date`);
  }
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/**
 * Template CSV → staged-row shapes. Throws only on a file-level problem
 * (wrong header, no data rows); every row-level problem excludes just that
 * row with a reason.
 */
export function parseImportCsv(
  text: string,
  parties: ImportParty[]
): { rows: ImportRow[]; included: number; excluded: number } {
  const records = parseCsv(text);
  if (records.length === 0) throw new Error("The file is empty.");
  const header = records[0].map((h) => h.trim().toLowerCase());
  const expected = TEMPLATE_HEADERS.join(",");
  if (
    header.length !== TEMPLATE_HEADERS.length ||
    TEMPLATE_HEADERS.some((h, i) => header[i] !== h)
  ) {
    throw new Error(
      `Header row must be exactly "${expected}" — download the template and fill it in.`
    );
  }
  if (records.length === 1) {
    throw new Error("No data rows below the header.");
  }

  // parties.name has no UNIQUE constraint — a name collision must surface as
  // a row problem, never resolve silently to whichever id came last.
  const partyByName = new Map<string, number | "ambiguous">();
  for (const p of parties) {
    const key = p.name.trim().toLowerCase();
    partyByName.set(key, partyByName.has(key) ? "ambiguous" : p.id);
  }

  const rows: ImportRow[] = records.slice(1).map((cells, idx) => {
    const cell = (i: number) => (cells[i] ?? "").trim();
    const problems: string[] = [];

    let entry_date: string | null = null;
    try {
      entry_date = parseTemplateDate(cell(0));
    } catch (e) {
      problems.push(e instanceof Error ? e.message : "bad date");
    }

    const particulars = cell(1);
    const ref_no = cell(2);

    let party_id: number | null = null;
    const partyName = cell(3);
    if (partyName !== "") {
      const id = partyByName.get(partyName.toLowerCase());
      if (id === undefined) {
        problems.push(`unknown party "${partyName}" — add them in Parties first`);
      } else if (id === "ambiguous") {
        problems.push(
          `party "${partyName}" matches more than one party — rename one so the name is unique`
        );
      } else {
        party_id = id;
      }
    }

    let entry_type: EntryType = "other";
    const typeRaw = cell(4).toLowerCase().replace(/\s+/g, "_");
    if (typeRaw === "") {
      problems.push("entry_type is required");
    } else if (!ENTRY_TYPES.includes(typeRaw as EntryType)) {
      problems.push(`unknown entry_type "${cell(4)}"`);
    } else {
      entry_type = typeRaw as EntryType;
      if (entry_type === "other") {
        problems.push("type 'other' is unpostable — pick a real type at review");
      }
    }

    const money = (i: number, side: string): number | null => {
      const raw = cell(i);
      if (raw === "") return null;
      try {
        const paise = rupeeStringToPaise(raw);
        if (paise < 0) throw new Error(`${side} must not be negative`);
        return paise === 0 ? null : paise;
      } catch (e) {
        problems.push(e instanceof Error ? e.message : `bad ${side}`);
        return null;
      }
    };
    const debit_paise = money(5, "debit");
    const credit_paise = money(6, "credit");
    if (debit_paise !== null && credit_paise !== null) {
      problems.push("has both debit and credit — a row takes exactly one");
    } else if (debit_paise === null && credit_paise === null) {
      problems.push("needs an amount in debit or credit");
    }

    let gst_rate: number | null = null;
    const rateRaw = cell(7).replace(/%$/, "");
    if (rateRaw !== "") {
      const rate = Number(rateRaw);
      if (!GST_RATES.includes(rate as (typeof GST_RATES)[number])) {
        problems.push(`GST rate must be one of ${GST_RATES.join("/")}`);
      } else {
        gst_rate = rate;
      }
    }

    let settle_account: SettleAccount = "cash";
    const settleRaw = cell(8).toLowerCase();
    if (settleRaw === "bank") settle_account = "bank";
    else if (settleRaw !== "" && settleRaw !== "cash") {
      problems.push(`settle_account must be cash or bank, not "${cell(8)}"`);
    }

    const reason = problems.join("; ");
    return {
      row_no: idx + 1,
      entry_date,
      particulars: reason ? `${particulars} — ⚠ ${reason}` : particulars,
      ref_no,
      debit_paise,
      credit_paise,
      entry_type,
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
