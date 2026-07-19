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
- **P3 vouchers + keys** — src/lib/vouchers.ts postManualVoucher (structured
  kinds → buildLegs with server-side party-kind guard; contra cash↔bank;
  free-form journal legs; source_document_id NULL; one tx) + assertNotLocked
  (books_locked_through, inclusive) wired inside postDocument's tx too;
  createVoucher + createVoucherParty (Alt+C inline, returns row — no redirect)
  actions; /vouchers page (kind switch synced to ?kind=, recent-vouchers rail)
  + voucher-form (leg grid, live Dr/Cr in text-good/critical, submit disabled
  till valid); keymap.ts PURE Tally map (F4 Contra F5 Payment F6 Receipt F7
  Journal F8 Sale F9 Purchase ^F8/^F9 notes · F2 date · ^A post [voucher
  screen only] · Esc back · ⌥C create · ? overlay [not while typing]; Cmd
  never hijacked) + shortcuts.tsx provider (CustomEvents → form) +
  shortcut-overlay; sidebar Vouchers item; statusbar key hints. 110 tests.
  Review: 0 blockers, 1 warn (party-kind guard) fixed + tested pre-commit.

## Current state
- Branch `feat/rvos-002-accountant-edition`; all four gates green at P3 commit.
- EVOLUTION.md at #11 (P3: "form filters are not server validation" rule).

## Next phase: P4 excel (CSV) import
Per RVOS-002-SPEC.md §PHASES + dreamy-skipping-mango.md: format.ts
rupeeStringToPaise (exact, strips ₹/commas, rejects >2dp, no floats);
import-csv.ts RFC-4180 parser + TEMPLATE_HEADERS (date|particulars|ref_no|
party|entry_type|debit|credit|gst_rate|settle_account), bad rows → include=0
+ reason; ensureColumn documents.source_type ('photo'|'excel'|'tally') +
staged_rows.party_id (nullable, doc fallback); posting.ts row.party_id ??
doc.party_id (photo path bit-identical); /api/import/template +
/api/import/excel routes (sha256 dup, doc status 'extracted' + staged rows in
one tx); /imports page; review-table party column for imports; documents list
source pill; sidebar Imports item. Tests: import-csv (quoted cells/newlines,
1,23,456.78→12345678, float rejection, unknown party excluded, entry_type
whitelist) + posting per-row-party case. Smoke: CSV both demo parties →
import → post → TB zero. P4/P5 tests must import against a db created from
the ORIGINAL DDL (frozen staged CHECK regression net).

## Gotchas
- better-sqlite3: optional/reused SQL params MUST be `@named` (EVOLUTION #10).
- Server actions must re-enforce every relationship the form filters
  (party kind ↔ voucher kind etc.) — EVOLUTION #11.
- staged_rows.entry_type CHECK frozen (8 values); journals.entry_type is
  free-form (JournalKind); manual kinds live only on journals.
- posting.ts ↔ vouchers.ts import cycle is call-time-only — keep it that way
  (no top-level cross-evaluation).
- UI rupee input → paise via Math.round(n*100) client-side (review-table
  precedent); server re-validates Number.isInteger. Import parsing (P4) must
  instead use the exact-string path — never parseFloat on file data.
- smoke.ts must import db.ts ONLY after chdir; DEMO_MODE forced.
- Books lock is INCLUSIVE (entry_date <= locked_through rejects).
- Money-adjacent UI diffs: code-review before commit (caught real bugs in P2+P3).
- Pinned demo BS figures (postedDb, 2027-03-31): assets 2,158,000p =
  liabilities 558,000p + equity 1,600,000p; profit 1,100,000p; AR 1,258,000p.

## Files touched (P3)
src/lib/{vouchers,keymap}.ts (new) · src/lib/{actions,posting}.ts ·
src/components/{shortcuts,shortcut-overlay,voucher-form}.tsx (new) ·
src/components/{sidebar,statusbar}.tsx · src/app/layout.tsx ·
src/app/vouchers/page.tsx (new) · scripts/smoke.ts ·
test/{keymap,vouchers}.test.ts (new) · EVOLUTION.md · HANDOFF.md
