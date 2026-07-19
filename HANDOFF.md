# RVOS-002 HANDOFF

## Done phases
- **P1 foundation** — commit `16135e6`. FY math (`src/lib/fy.ts`), COA groups
  (`src/lib/coa.ts`), db migrations (accounts.group_code + 7 settings fields via
  ensureColumn), seed 13→23 accounts w/ idempotent backfill, settings page +
  `/settings/accounts` CRUD (add/rename only), Apple-light shell (globals.css
  Light tokens, frosted topbar/statusbar, grouped collapsible sidebar Ctrl+B +
  hover-peek), smoke pinned to SEED_ACCOUNTS.length, tests fy+coa (15 new, 87 total).
- **P2 statements** — trialBalance(asOf?), profitAndLoss(month | {from,to}),
  balanceSheet(db, asOf, settings) with COMPUTED retained-earnings +
  current-year-profit injection (never posted) and A=L+E throw (4th balance
  guard); GST accounts netted under duties & taxes; `/reports/balance-sheet`
  page (FY select + as-of date), fy-select component (allowBlank + blankLabel),
  P&L page + export `?fy=` FY windows, export `case "balance-sheet"`,
  report-tabs = segmented control in statement order (TB→P&L→BS→GST→Day book).
  8 new BS tests (95 total) + smoke BS/FY legs. code-reviewer on the diff:
  1 blocker (no-op Apply silently jumped as-of to FY-end via pre-seeded
  FySelect) — fixed with allowBlank/"As of today".

## Current state
- Branch `feat/rvos-002-accountant-edition`, all four gates green at P2 commit.
- EVOLUTION.md at entry #10 (P2: better-sqlite3 reused-`?N`-param rule).

## Next phase: P3 vouchers + keys
Per RVOS-002-SPEC.md §PHASES + dreamy-skipping-mango.md: src/lib/vouchers.ts
postManualVoucher (structured kinds → buildLegs; contra builder; journal →
explicit legs; source_document_id NULL) + assertNotLocked (settings.
books_locked_through) wired into postDocument tx; createVoucher action;
/vouchers page + voucher-form (kind switch, leg grid, live Dr/Cr totals);
src/lib/keymap.ts (pure, tested) + shortcuts provider + ? overlay; Tally keys
F4–F9/^F8/^F9/F2/^A/Esc/Alt+C; sidebar NAV + Vouchers; JournalKind gains
"contra"; tests keymap + vouchers; smoke manual-journal + lock legs.

## Gotchas
- better-sqlite3: optional/reused SQL params MUST be `@named` bound via one
  object — `?N` positional throws "Too many parameter values" (EVOLUTION #10).
- staged_rows.entry_type CHECK frozen (8 values); journals.entry_type free-form
  (JournalKind in types.ts).
- smoke.ts must import db.ts ONLY after chdir (DATA_DIR anchors to cwd at import).
- Sidebar collapse visuals are CSS-only off `html[data-sidebar]`; pre-paint
  script in layout.tsx restores state — don't move it below <Sidebar/>.
- Topbar is a server comp reading settings in the root layout; /_not-found and
  the /reports redirect are the only static routes (harmless).
- Money-adjacent UI diffs (dates/amounts/include flags): /code-review before commit.
- Pinned demo BS figures (postedDb, 2027-03-31): assets 2,158,000p =
  liabilities 558,000p + equity 1,600,000p; profit 1,100,000p; AR 1,258,000p.

## Files touched (P2)
src/lib/reports.ts · src/app/api/export/[report]/route.ts ·
src/components/{report-tabs,fy-select}.tsx · src/app/reports/balance-sheet/
page.tsx (new) · src/app/reports/pnl/page.tsx · scripts/smoke.ts ·
test/balance-sheet.test.ts (new) · EVOLUTION.md · HANDOFF.md
