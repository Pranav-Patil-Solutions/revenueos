# RVOS-002 HANDOFF

## Done phases
- **P1 foundation** — commit `16135e6`. FY math (`src/lib/fy.ts`), COA groups
  (`src/lib/coa.ts`), db migrations (accounts.group_code + 7 settings fields via
  ensureColumn), seed 13→23 accounts w/ idempotent backfill, settings page +
  `/settings/accounts` CRUD (add/rename only), Apple-light shell, smoke pinned
  to SEED_ACCOUNTS.length, tests fy+coa (87 total).
- **P2 statements** — commit `57de059`. trialBalance(asOf?), profitAndLoss FY
  ranges, balanceSheet with computed retained-earnings/current-year-profit
  injection + A=L+E throw, GST netted under duties & taxes, BS page + fy-select,
  P&L/export `?fy=`, segmented report tabs. 95 tests. Review blocker (no-op
  Apply jumped as-of to FY-end) fixed pre-commit.
- **P3 vouchers + keys** — commit `f4414ab`. vouchers.ts postManualVoucher
  (structured kinds → buildLegs w/ server-side party-kind guard; contra;
  free-form journal; one tx) + assertNotLocked (inclusive) in both posting
  paths; /vouchers page + voucher-form; keymap.ts pure Tally map (F4–F9,
  ^F8/^F9, F2, ^A, Esc, ⌥C, ?) + shortcuts provider + overlay; statusbar
  hints. 110 tests. Review warn (party-kind guard) fixed + tested pre-commit
  → EVOLUTION #11.
- **P4 excel (CSV) import** — format.ts `rupeeStringToPaise` (exact string→
  paise, strips ₹/commas, rejects >2dp, digit math only — NEVER parseFloat on
  file data); import-csv.ts RFC-4180 `parseCsv` + `parseImportCsv`
  (TEMPLATE_HEADERS date|particulars|ref_no|party|entry_type|debit|credit|
  gst_rate|settle_account; bad cell/unknown party/AMBIGUOUS party → include=0
  + reason suffixed onto particulars, confidence 0.2; unknown entry_type falls
  to 'other' so the frozen CHECK always holds); db.ts ensureColumn
  documents.source_type ('photo'|'excel'|'tally' default 'photo') +
  staged_rows.party_id (nullable); posting.ts per-row `row.party_id ??
  doc.party_id` via partyFor cache (photo path bit-identical);
  /api/import/template (CSV + 3 example rows) + /api/import/excel (multipart,
  BOM strip, .xlsx rejected w/ save-as-CSV hint, sha256 dup warning, doc
  'extracted' + staged rows ONE tx); /imports page (Excel card + Tally
  placeholder) + import-excel.tsx; review-table optional Party column
  (partyNames/defaultPartyName props — hidden on photo path); documents list
  source pill + csv icon tile; documents/[id] source-aware (no LedgerImage/
  re-extract for non-photo, full-width table); sidebar Imports. 123 tests
  (13 new incl. original-DDL end-to-end + ambiguous-party pin); smoke CSV leg
  (both demo parties, doc-fallback + per-row party, TB zero). Review: 1
  blocker (duplicate party names resolved silently last-write-wins) fixed +
  pinned pre-commit → EVOLUTION #12.

## Current state
- Branch `feat/rvos-002-accountant-edition`; all four gates green at P4.
- EVOLUTION.md at #12 (P4: name→id maps must detect collisions).

## Next phase: P5 tally import
Per RVOS-002-SPEC.md §PHASES + dreamy-skipping-mango.md: dep fast-xml-parser
(THE only new dep of the build); import-tally.ts `parseDayBook(xml)`
(ENVELOPE→TALLYMESSAGE→VOUCHER; Sales/Purchase/Receipt/Payment/Credit Note/
Debit Note/Journal → frozen 8-value enum; amounts via rupeeStringToPaise;
complex multi-ledger journals → 'other', include=0, "post manually via
Vouchers") + `unmappedLedgers()`; db.ts DDL ledger_mappings (ledger_name
UNIQUE, target_kind CHECK('account','party'), account_id, party_id,
created_at); /imports/tally page (upload → unmapped-ledger mapping form →
confirm → doc source_type 'tally' → review); actions saveLedgerMappings +
createTallyImport. Accept: test/import-tally.test.ts (inline XML fixture:
sale+receipt+payment+complex journal; exact paise; mapping persists across a
second import; complex journal excluded-with-reason). Smoke: tiny XML → map
→ post → TB zero. Commit: `RVOS-002 P5: tally import — day book XML via
fast-xml-parser, persistent ledger mapping, staged review landing`.

## Gotchas
- better-sqlite3: optional/reused SQL params MUST be `@named` (EVOLUTION #10).
- Server actions must re-enforce every relationship the form filters
  (party kind ↔ voucher kind etc.) — EVOLUTION #11.
- Name→id lookup maps MUST detect collisions (no UNIQUE on parties.name);
  ambiguous = per-row error, never last-write-wins — EVOLUTION #12. Applies
  directly to P5 ledger mapping (ledger_mappings.ledger_name IS unique, but
  the party/account targets it points AT come from name matching).
- staged_rows.entry_type CHECK frozen (8 values); anything unmappable lands
  as 'other' + include=0 + reason; journals.entry_type is free-form
  (JournalKind); P5 tests must run against a db from the ORIGINAL DDL
  (initSchema on :memory: — the import-csv end-to-end test is the pattern).
- posting.ts ↔ vouchers.ts import cycle is call-time-only — keep it that way.
- Import parsing uses rupeeStringToPaise (exact string path) — never
  parseFloat/toPaise on file data; UI rupee inputs (review grid) still use
  Math.round(n*100) client-side, server re-validates Number.isInteger.
- staged_rows.party_id NULL = doc's party (photo path bit-identical);
  applyDraftRows never touches party_id so review edits preserve it.
- Excel-on-Windows CSVs open with a UTF-8 BOM — /api/import/excel strips it.
- smoke.ts must import db.ts ONLY after chdir; DEMO_MODE forced.
- Books lock is INCLUSIVE (entry_date <= locked_through rejects).
- Money-adjacent diffs: code-review before commit (caught real bugs P2+P3+P4).
- Pinned demo BS figures (postedDb, 2027-03-31): assets 2,158,000p =
  liabilities 558,000p + equity 1,600,000p; profit 1,100,000p; AR 1,258,000p.
  Smoke's CSV leg posts in 2026-08 (after these assertions run) so the July
  GST + BS pins stay untouched.

## Files touched (P4)
src/lib/import-csv.ts (new) · src/lib/{format,db,posting,types}.ts ·
src/app/api/import/{template,excel}/route.ts (new) ·
src/app/imports/page.tsx (new) · src/components/import-excel.tsx (new) ·
src/components/{review-table,sidebar}.tsx ·
src/app/documents/page.tsx · src/app/documents/[id]/page.tsx ·
scripts/smoke.ts · test/import-csv.test.ts (new) · test/posting.test.ts ·
EVOLUTION.md · HANDOFF.md
