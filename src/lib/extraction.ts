import path from "node:path";
import type { Book } from "./book";
import { getCompany } from "./companies";
import { claudeVision } from "./llm-cli";
import {
  extractJsonObject,
  validateExtraction,
  type ExtractionResult,
} from "./extraction-schema";
import { todayIso } from "./format";
import type { DocumentWithParty, SettingsRow } from "./types";

export function extractModel(): string {
  return process.env.REVENUEOS_EXTRACT_MODEL ?? "claude-sonnet-5";
}

/**
 * Canned extraction for DEMO_MODE=1 — exercises the full review → post →
 * reports pipeline with zero subscription burn. Dates are fixed (July 2026)
 * so the derived numbers are deterministic: with row 10 excluded at review
 * and row 11 auto-excluded, AR(Sharma Traders) = ₹12,580.00, GSTR-3B outward
 * taxable ₹16,000.00, CGST+SGST ₹1,290.00 each, ITC ₹900.00.
 */
export const DEMO_FIXTURE = {
  page: {
    party_name_hint: "Sharma Traders",
    period_hint: "July 2026",
    has_balance_column: true,
    notes: "Demo fixture — canned extraction, no LLM call.",
  },
  rows: [
    { row_no: 1, entry_date: "2026-07-01", particulars: "To Opening Balance", ref_no: null, debit: 5000, credit: null, entry_type: "opening", gst_rate: null, confidence: 0.95, is_balance_row: false },
    { row_no: 2, entry_date: "2026-07-02", particulars: "To Sales — cloth bill #241", ref_no: "241", debit: 11800, credit: null, entry_type: "sale", gst_rate: 18, confidence: 0.92, is_balance_row: false },
    { row_no: 3, entry_date: "2026-07-05", particulars: "By Cash", ref_no: null, debit: null, credit: 7000, entry_type: "receipt", gst_rate: null, confidence: 0.95, is_balance_row: false },
    { row_no: 4, entry_date: "2026-07-08", particulars: "To Sales — suit lengths #248", ref_no: "248", debit: 5600, credit: null, entry_type: "sale", gst_rate: 12, confidence: 0.9, is_balance_row: false },
    { row_no: 5, entry_date: "2026-07-10", particulars: "कपड़ा बिक्री / kapda bikri #252", ref_no: "252", debit: 2360, credit: null, entry_type: "sale", gst_rate: 18, confidence: 0.88, is_balance_row: false },
    { row_no: 6, entry_date: "2026-07-12", particulars: "By Bank NEFT", ref_no: null, debit: null, credit: 4000, entry_type: "receipt", gst_rate: null, settle_account: "bank", confidence: 0.93, is_balance_row: false },
    { row_no: 7, entry_date: "2026-07-13", particulars: "By Credit Note CN-07 (return)", ref_no: "CN-07", debit: null, credit: 1180, entry_type: "credit_note", gst_rate: 18, confidence: 0.85, is_balance_row: false },
    { row_no: 8, entry_date: "2026-07-14", particulars: "To Purchases — packing inv 88", ref_no: "88", debit: null, credit: 5900, entry_type: "purchase", gst_rate: 18, confidence: 0.9, is_balance_row: false },
    { row_no: 9, entry_date: "2026-07-15", particulars: "By Cash paid", ref_no: null, debit: 2000, credit: null, entry_type: "payment", gst_rate: null, settle_account: "cash", confidence: 0.92, is_balance_row: false },
    { row_no: 10, entry_date: null, particulars: "—illegible—", ref_no: null, debit: null, credit: null, entry_type: "other", gst_rate: null, confidence: 0.3, is_balance_row: false },
    { row_no: 11, entry_date: "2026-07-15", particulars: "Balance c/d", ref_no: null, debit: null, credit: 12580, entry_type: "opening", gst_rate: null, confidence: 0.95, is_balance_row: true },
  ],
};

export function buildExtractionPrompt(
  doc: DocumentWithParty,
  settings: SettingsRow
): string {
  const imageAbs = path.join(process.cwd(), doc.image_path);
  const isCustomer = doc.party_kind === "customer";
  return `You are a meticulous Indian accountant digitizing a handwritten ledger (khata) page or printed statement.

Read the ledger-page photo at ${imageAbs} using the Read tool. Then extract every ledger row.

CONTEXT
- This page is the ledger of ${doc.party_name}, a ${doc.party_kind} of ${settings.company_name} (the company whose books we keep).
- Today's date: ${todayIso()}.

ENTRY-TYPE MAPPING (this is a ${doc.party_kind.toUpperCase()} ledger)
${
    isCustomer
      ? `- DEBIT rows (they owe more) are normally "sale"; DEBIT rows that are money we paid them back are "payment".
- CREDIT rows (they owe less) are normally "receipt" (they paid us); a credited sales return is "credit_note"; goods we bought FROM this customer are "purchase".`
      : `- CREDIT rows (we owe more) are normally "purchase"; CREDIT rows for returned-money adjustments are "debit_note" reversals only when explicitly a debit note.
- DEBIT rows (we owe less) are normally "payment" (we paid them); a debited purchase return is "debit_note"; goods sold TO this supplier are "sale".`
  }
- "Balance b/f", "Balance c/d", "Balance c/f", "शेष", "बाकी", "C/F" rows: entry_type "opening" AND is_balance_row true.
- Anything you cannot classify: entry_type "other".

COLUMN MAPPING
- Devanagari and khata conventions: नावे / नामे / "To …" / उधार mark the DEBIT side; जमा / "By …" mark the CREDIT side.
- Some pages have a single Amount column with a Dr/Cr marker per row — map Dr to debit, Cr to credit.
- If the page has a running-balance column, do NOT emit it as debit/credit. Set page.has_balance_column true and use it to self-check your rows: if opening balance plus your debits minus your credits does not reproduce the running balance, lower confidence to 0.5 or below on the rows that disagree.

AMOUNTS
- Indian number grouping (1,23,456.78). Strip ₹, /-, and = marks. Output plain numbers in rupees (paise as decimals).
- Each row has exactly ONE of debit or credit — never both.

DATES
- Formats like dd/mm/yy or dd/mm/yyyy. Infer the year from the page heading when a row omits it.
- Ditto marks (〃, ", -do-) inherit the previous row's date.
- Output ISO YYYY-MM-DD, or null when unreadable.

TEXT
- particulars: copy the text verbatim in its original script, then " / " and a short English transliteration (e.g. "कपड़ा बिक्री / kapda bikri").
- Unreadable text or amounts: use null and confidence 0.4 or below for that row.

GST
- gst_rate: set 0, 5, 12, 18, or 28 ONLY when the page itself evidences it (printed rate, tax column, bill reference known to be taxed). Otherwise null.

Respond with ONLY a raw JSON object — no markdown fences, no prose —
{"page":{"party_name_hint":str|null,"period_hint":str|null,"has_balance_column":bool,"notes":str},"rows":[{"row_no":1,"entry_date":"YYYY-MM-DD"|null,"particulars":str,"ref_no":str|null,"debit":num|null,"credit":num|null,"entry_type":"sale|receipt|purchase|payment|credit_note|debit_note|opening|other","gst_rate":num|null,"confidence":0.9,"is_balance_row":false}]}`;
}

function persistExtraction(
  book: Book,
  docId: number,
  result: ExtractionResult,
  model: string
): void {
  book.tx((b) => {
    b.run("DELETE FROM staged_rows WHERE document_id = @docId AND company_id = @company_id", {
      docId,
    });
    for (const r of result.rows) {
      b.run(
        `INSERT INTO staged_rows
           (document_id, row_no, entry_date, particulars, ref_no, debit_paise, credit_paise,
            entry_type, gst_rate, settle_account, confidence, is_balance_row, include, company_id)
         VALUES (@docId, @row_no, @entry_date, @particulars, @ref_no, @debit_paise, @credit_paise,
                 @entry_type, @gst_rate, @settle_account, @confidence, @is_balance_row, @include, @company_id)`,
        {
          docId,
          row_no: r.row_no,
          entry_date: r.entry_date,
          particulars: r.particulars,
          ref_no: r.ref_no,
          debit_paise: r.debit_paise,
          credit_paise: r.credit_paise,
          entry_type: r.entry_type,
          gst_rate: r.gst_rate,
          settle_account: r.settle_account,
          confidence: r.confidence,
          is_balance_row: r.is_balance_row ? 1 : 0,
          include: r.include ? 1 : 0,
        }
      );
    }
    b.run(
      `UPDATE documents SET status = 'extracted', error = '', model = @model, extracted_at = @now
       WHERE id = @docId AND company_id = @company_id`,
      { model, now: new Date().toISOString(), docId }
    );
  });
}

function humanizeExtractionError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/ENOENT/.test(msg)) {
    return "Claude CLI not found — install and authenticate the `claude` CLI on this machine.";
  }
  return msg;
}

/** uploaded/failed/extracted → extracting → extracted (or failed). Re-extract
 * is allowed any number of times until the document is posted. Every query is
 * scoped to `book`'s active company — RVOS-004 P6. */
export async function extractDocument(
  book: Book,
  docId: number
): Promise<{ rows: number }> {
  const doc = book.get(
    `SELECT d.*, p.name AS party_name, p.kind AS party_kind, p.state_code AS party_state_code
     FROM documents d
     JOIN parties p ON p.id = d.party_id AND p.company_id = @company_id
     WHERE d.id = @docId AND d.company_id = @company_id`,
    { docId }
  ) as DocumentWithParty | undefined;
  if (!doc) throw new Error("Document not found.");
  if (doc.status === "posted") {
    throw new Error("Document is posted — its rows are locked.");
  }

  book.run(
    "UPDATE documents SET status = 'extracting', error = '' WHERE id = @docId AND company_id = @company_id",
    { docId }
  );

  try {
    if (process.env.DEMO_MODE === "1") {
      await new Promise((r) => setTimeout(r, 800));
      const result = validateExtraction(DEMO_FIXTURE);
      persistExtraction(book, docId, result, "demo-fixture");
      return { rows: result.rows.length };
    }

    // requireBook() already asserted this company exists and is active.
    const settings = getCompany(book.db, book.companyId)!;
    const model = extractModel();
    const prompt = buildExtractionPrompt(doc, settings);

    let lastError = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      const nudge =
        attempt === 0
          ? ""
          : `\n\nYour previous output was invalid (${lastError}). Output ONLY the raw JSON object this time.`;
      let reply: string;
      try {
        reply = await claudeVision({ model, prompt: prompt + nudge });
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e);
        continue;
      }
      try {
        const result = validateExtraction(
          JSON.parse(extractJsonObject(reply))
        );
        persistExtraction(book, docId, result, model);
        return { rows: result.rows.length };
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e);
      }
    }
    throw new Error(lastError || "extraction failed");
  } catch (e) {
    const message = humanizeExtractionError(e);
    book.run(
      "UPDATE documents SET status = 'failed', error = @message WHERE id = @docId AND company_id = @company_id",
      { message, docId }
    );
    throw new Error(message);
  }
}
