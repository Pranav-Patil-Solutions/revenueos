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
- **P4 excel (CSV) import** — commit `0b680fa`. format.ts `rupeeStringToPaise`
  (exact string→paise, strips ₹/commas, rejects >2dp, digit math only — NEVER
  parseFloat on file data); import-csv.ts RFC-4180 `parseCsv` +
  `parseImportCsv` (TEMPLATE_HEADERS date|particulars|ref_no|party|entry_type|
  debit|credit|gst_rate|settle_account; bad cell/unknown party/AMBIGUOUS party
  → include=0 + reason suffixed onto particulars, confidence 0.2; unknown
  entry_type falls to 'other' so the frozen CHECK always holds); db.ts
  ensureColumn documents.source_type ('photo'|'excel'|'tally' default 'photo')
  + staged_rows.party_id (nullable); posting.ts per-row `row.party_id ??
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
- **P5 tally import** — dep `fast-xml-parser@5` (THE only new dep of the
  build). `src/lib/import-tally.ts`: `parseDayBook(xml)` collects VOUCHER
  nodes at ANY depth (Tally's envelope shape varies by export path) with
  `parseTagValue:false` so amounts stay strings for `rupeeStringToPaise`;
  Tally sign convention negative=debit; each voucher's legs must sum to zero
  or it is not trusted. `unmappedLedgers()` (asks only about importable
  vouchers), `suggestTarget()` (exact unique name match only — null on any
  collision, EVOLUTION #12), `tallyVouchersToRows()` collapsing one voucher →
  one staged row keyed on its single party leg. db.ts DDL `ledger_mappings`
  (ledger_name UNIQUE, target_kind CHECK('account','party'), paired CHECKs so
  exactly one target id is non-null). `/api/import/tally/preview` (parse +
  park file under a UUID token + report unmapped ledgers/suggestions/dup) and
  server action `createTallyImport` (strict UUID token regex, server-side
  re-validation of every party/account id, mapping upsert + document +
  staged rows in ONE tx). `/imports` Tally card + import-tally.tsx two-phase
  form. 144 tests (21 new); smoke Tally leg posts in 2026-09 (after every
  pinned July/FY assertion). Review: 2 blockers (settlement defaulting to
  cash; unconsumed legs silently dropped) fixed + pinned pre-commit →
  EVOLUTION #13.

## Current state
- Branch `feat/rvos-002-accountant-edition`; all four gates green at P5.
- EVOLUTION.md at #13 (P5: balance is not proof of faithfulness).
- Live-DB compat spot-checked on a COPY of `data/revenueos.db` (+WAL):
  `ledger_mappings` created additively, 6 documents / 27 journal lines intact.
- The Tally flow was also driven end-to-end in a real browser on :3322
  (map → stage → review, second import asked zero ledgers, duplicate-bytes
  banner fired). Those test artifacts were then removed — the live book is
  back to its exact prior baseline (6 docs / 40 staged rows / 0 mappings /
  27 journal lines). Do NOT expect leftover tally documents there.

## What the Tally path refuses (by design — never guess with money)
Each of these lands `include=0`, entry_type `'other'`, confidence 0.2, with
the reason suffixed onto particulars so review shows it:
- a voucher type outside Sales/Purchase/Receipt/Payment/Credit Note/Debit Note
  (Journal, Contra, stock, user-defined) — "post it manually via Vouchers";
- zero or 2+ party ledgers (a cash sale is a sale *plus* a receipt);
- a party ledger on the side opposite to the voucher type (would post backwards);
- a settlement with no cash/bank leg, or more than one;
- ANY leg left unconsumed — TDS withheld, discount, freight, round-off, a fixed
  asset on a Purchase voucher (EVOLUTION #13);
- GST that doesn't reconcile EXACTLY to a rate in GST_RATES;
- an unmapped ledger, or a mapping with a broken target.
Multiple same-type revenue legs DO import (buildLegs sums them into Sales).

## Next phase: P6 depreciation
Per RVOS-002-SPEC.md §PHASES + dreamy-skipping-mango.md: new
`src/lib/tax/depreciation.ts` `IT_BLOCKS` (building 10%, furniture 10%, plant
& machinery 15%, vehicles 15%, computers 40% — rate + label + seed account) and
`blockWdv(db, fy, block)` = opening (from `wdv_openings` first-FY override,
else prior-FY closing) + additions split ≥180/<180 days to Mar 31 (half rate)
− disposals → dep + closing, integer paise via `roundHalfUp`. db.ts DDL
`fixed_assets` (name, block CHECK, cost_paise, purchase_date, put_to_use_date,
disposed_date, disposal_paise) + `wdv_openings` (fy, block, opening_paise,
UNIQUE(fy, block)). New `/tax` page (redirect → computation) +
`tax-tabs.tsx` (Computation/Depreciation/TDS, ReportTabs clone) +
`/tax/depreciation` (register, per-FY block summary, "Post depreciation
entry"); actions `createAsset`, `disposeAsset`, `postDepreciationEntry(fy)`
(Dr 5800 / Cr 1590 via postManualVoucher, journals.entry_type 'depreciation',
refuses if an entry already exists for that FY). Sidebar NAV + Tax. Export
`case "depreciation"`. Accept: `test/depreciation.test.ts` — 180-day boundary
half-rate flip, block roll-forward across 2 FYs, opening override, disposal
capped at block WDV, double-post guard. Smoke: ₹1,00,000 computers asset
mid-year → dep ₹20,000 pinned → posted, TB zero, BS net block. Commit:
`RVOS-002 P6: depreciation — fixed-asset register, IT-Act WDV blocks with
half-year rule, generated FY depreciation journal`.

## Gotchas
- better-sqlite3: optional/reused SQL params MUST be `@named` (EVOLUTION #10).
- Server actions must re-enforce every relationship the form filters
  (party kind ↔ voucher kind etc.) — EVOLUTION #11.
- Name→id lookup maps MUST detect collisions (no UNIQUE on parties.name);
  ambiguous = per-row error, never last-write-wins — EVOLUTION #12.
- Collapsing N source legs into one internal row: every leg must be explicitly
  consumed or explicitly refused. The collapsed entry is re-derived from a
  control total, so it BALANCES even when legs were dropped — balance proves
  nothing about faithfulness (EVOLUTION #13). Applies to any future importer.
- `buildLegs` uses `row.gst_rate ?? settings.default_gst_rate` — a NULL rate
  silently applies 18%. Importers must stage `gst_rate = 0` for a zero-tax
  entry, never null.
- `buildLegs` treats the staged amount as GROSS when settings.tax_inclusive=1
  and as TAXABLE when 0; Tally's party leg is ALWAYS the gross, so
  import-tally's `inferGst` returns which amount to stage per book mode.
- staged_rows.entry_type CHECK frozen (8 values); anything unmappable lands
  as 'other' + include=0 + reason; journals.entry_type is free-form
  (JournalKind); P5/P6 tests must run against a db from the ORIGINAL DDL
  (initSchema on :memory: — the import-csv/import-tally end-to-end tests are
  the pattern).
- posting.ts ↔ vouchers.ts import cycle is call-time-only — keep it that way.
- `ACC` (account codes) is exported from posting.ts — importers classify
  ledgers against the SAME codes the engine posts to. Don't re-declare them.
- Import parsing uses rupeeStringToPaise (exact string path) — never
  parseFloat/toPaise on file data; UI rupee inputs (review grid) still use
  Math.round(n*100) client-side, server re-validates Number.isInteger.
- staged_rows.party_id NULL = doc's party (photo path bit-identical);
  applyDraftRows never touches party_id so review edits preserve it.
- Excel-on-Windows CSVs and Tally-on-Windows XML both carry a UTF-8 BOM —
  both upload paths strip it.
- `tsc --noEmit` covers `test/` too (Next's build does not) — run it before
  committing; a regex `/s` flag exceeds the configured target, use `[\s\S]`.
- smoke.ts must import db.ts ONLY after chdir; DEMO_MODE forced. Beware name
  collisions with earlier bindings in that one long main() (`dayBook` the
  report fn vs a day-book fixture).
- Books lock is INCLUSIVE (entry_date <= locked_through rejects).
- Money-adjacent diffs: code-review before commit (caught real bugs P2+P3+P4+P5).
- Pinned demo BS figures (postedDb, 2027-03-31): assets 2,158,000p =
  liabilities 558,000p + equity 1,600,000p; profit 1,100,000p; AR 1,258,000p.
  Smoke's CSV leg posts in 2026-08 and the Tally leg in 2026-09, both AFTER
  these assertions run, so the July GST + BS pins stay untouched.

## Files touched (P5)
src/lib/import-tally.ts (new) · src/components/import-tally.tsx (new) ·
src/app/api/import/tally/preview/route.ts (new) ·
test/import-tally.test.ts (new) ·
src/lib/{db,types,posting,actions}.ts · src/app/imports/page.tsx ·
scripts/smoke.ts · package.json (+fast-xml-parser) ·
EVOLUTION.md · HANDOFF.md
