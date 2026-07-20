export type AccountType = "asset" | "liability" | "equity" | "income" | "expense";
export type PartyKind = "customer" | "supplier";
export type DocumentStatus =
  | "uploaded"
  | "extracting"
  | "extracted"
  | "posted"
  | "failed";
export type EntryType =
  | "sale"
  | "receipt"
  | "purchase"
  | "payment"
  | "credit_note"
  | "debit_note"
  | "opening"
  | "other";
export type SettleAccount = "cash" | "bank";
export type SourceType = "photo" | "excel" | "tally";
export type LedgerTargetKind = "account" | "party";
export type EntityType = "proprietorship" | "partnership" | "company";
export type ItRegime = "old" | "new";
export type Presumptive = "" | "44AD" | "44ADA";
/** journals.entry_type has no CHECK — manual/generated kinds live here.
 * staged_rows.entry_type stays the frozen 8-value EntryType enum. */
export type JournalKind =
  | EntryType
  | "journal"
  | "contra"
  | "depreciation"
  | "tds_challan";

// Row types mirror the sqlite column names exactly (snake_case) so queries
// need no aliasing. All money columns are INTEGER paise.

export interface SettingsRow {
  id: number;
  company_name: string;
  gstin: string;
  state_code: string;
  country: string;
  currency: string;
  default_gst_rate: number;
  tax_inclusive: number; // 0 | 1
  entity_type: EntityType;
  pan: string;
  tan: string;
  it_regime: ItRegime;
  presumptive: Presumptive;
  books_locked_through: string; // ISO YYYY-MM-DD, '' = books open
  fy_audit_case: number; // 0 | 1 — audit case pushes the ITR due date
}

export interface AccountRow {
  id: number;
  code: string;
  name: string;
  type: AccountType;
  group_code: string | null;
}

export interface PartyRow {
  id: number;
  name: string;
  kind: PartyKind;
  gstin: string;
  state_code: string;
  phone: string;
  created_at: string;
}

export interface DocumentRow {
  id: number;
  party_id: number;
  image_path: string;
  image_sha256: string;
  status: DocumentStatus;
  source_type: SourceType;
  error: string;
  model: string;
  created_at: string;
  extracted_at: string | null;
  posted_at: string | null;
}

export interface DocumentWithParty extends DocumentRow {
  party_name: string;
  party_kind: PartyKind;
  party_state_code: string;
}

export interface StagedRow {
  id: number;
  document_id: number;
  row_no: number;
  entry_date: string | null; // ISO YYYY-MM-DD
  particulars: string;
  ref_no: string;
  debit_paise: number | null;
  credit_paise: number | null;
  entry_type: EntryType;
  gst_rate: number | null;
  settle_account: SettleAccount;
  confidence: number; // 0–1
  is_balance_row: number; // 0 | 1
  include: number; // 0 | 1
  posted_journal_id: number | null;
  party_id: number | null; // NULL = the document's party (photo path)
}

/** One edited review-grid row as sent by the client to save/post actions. */
export interface DraftRowInput {
  id: number;
  entry_date: string | null;
  particulars: string;
  ref_no: string;
  debit_paise: number | null;
  credit_paise: number | null;
  entry_type: EntryType;
  gst_rate: number | null;
  settle_account: SettleAccount;
  include: boolean;
}

export type ItAdjustmentKind = "addback" | "deduction";
export type TaxPaymentKind = "advance" | "tds" | "self_assessment";

export interface ItAdjustmentRow {
  id: number;
  fy: string;
  kind: ItAdjustmentKind;
  section: string;
  description: string;
  amount_paise: number;
  created_at: string;
}

export interface TaxPaymentRow {
  id: number;
  fy: string;
  kind: TaxPaymentKind;
  paid_on: string;
  amount_paise: number;
  note: string;
  created_at: string;
}

/** IT-Act depreciation block. Frozen alongside the CHECK lists on
 * fixed_assets.block / wdv_openings.block and IT_BLOCKS. */
export type BlockCode =
  | "building"
  | "furniture"
  | "plant"
  | "vehicles"
  | "computers";

export interface FixedAssetRow {
  id: number;
  name: string;
  block: BlockCode;
  cost_paise: number;
  purchase_date: string;
  put_to_use_date: string | null; // NULL = not yet in use, so not yet depreciable
  disposed_date: string | null;
  disposal_paise: number | null;
  created_at: string;
}

export interface WdvOpeningRow {
  id: number;
  fy: string;
  block: BlockCode;
  opening_paise: number;
  created_at: string;
}

/** Tally ledger name → account or party. Exactly one target id is non-null,
 * enforced by paired SQL CHECKs. */
export interface LedgerMappingRow {
  id: number;
  ledger_name: string;
  target_kind: LedgerTargetKind;
  account_id: number | null;
  party_id: number | null;
  created_at: string;
}

export interface JournalRow {
  id: number;
  entry_date: string;
  entry_type: JournalKind;
  memo: string;
  ref_no: string;
  source_document_id: number | null;
  source_row_id: number | null;
  created_at: string;
}

export interface JournalLineRow {
  id: number;
  journal_id: number;
  line_no: number;
  account_id: number;
  party_id: number | null;
  debit_paise: number;
  credit_paise: number;
}
