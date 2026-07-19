# RVOS-002 — RevenueOS Accountant Edition · Build Spec
# Owner: Pranav · Repo: ~/revenueos (LOCAL git only — disk is the only copy)
# Branch: feat/rvos-002-accountant-edition · master stays shippable, merge only after ship gate
# Ports: dev 3322 ONLY · DEMO_MODE=1 for all tests/smoke (never burn subscription)

## PRODUCT
One app for Dad's accounting office, per client business, end-to-end:
ledger writing → posting into double-entry books → statements → tax filing pack a CA signs.
Single business at a time (multi-client later). India regime. Local-first, Tailscale = perimeter.

## INVARIANTS (violating any = blocker)
- All money INTEGER paise. No floats in db or posting math.
- Journals balanced by construction: assertBalanced → SQL one-sided CHECK → trialBalance()==0; BS adds A=L+E throw.
- Post-only / fix-forward. No void/reverse. Posted docs locked.
- LLM transport = `claude` CLI via src/lib/llm-cli.ts ONLY. NEVER @anthropic-ai/sdk / ANTHROPIC_API_KEY.
- Schema evolves additively: ensureColumn() slot + CREATE TABLE IF NOT EXISTS in src/lib/db.ts. No migration framework.
- staged_rows.entry_type CHECK is FROZEN (8 values). New kinds live on journals.entry_type only
  (no CHECK there — verified): "journal" | "contra" | "depreciation" | "tds_challan".
- Next.js 16: params/searchParams are Promises — always await.

## UI DIRECTION (final, per approved preview artifact 60d1d93a)
Apple UI/UX over ERP bones:
- SF/system type, sentence case, −.005em tracking; large bold page titles.
- Light default: #f5f5f7 page / #fff cards / #007aff accent (dark alt: #1c1c1e / #0a84ff).
  Accent shade = Pranav's swatch pick from preview (8 options; token swap in globals.css).
- Cards 12px radius + hairline + whisper shadow; capsule pills; segmented-control report tabs.
- Tables: NO gridlines/zebra; hairline rows; tabular-nums; dense (~28px rows).
- Buttons: flat accent fill, brightness hover, scale(.98) press. Fields: borderless filled + focus ring.
- Sidebar: workflow order with numbered group headers —
  Overview · [1 Ledger entry] Capture, Vouchers, Imports · [2 Books] Documents, Parties ·
  [3 Statements] Reports · [4 Tax & filing] Tax, Compliance, CA pack · Settings.
  Collapsible to 62px icon rail (chevron + Ctrl+B, 300ms cubic-bezier, persisted) + hover-to-peek overlay.
- Frosted sticky topbar (company · entity · FY period · date · books-lock · GSTIN) + frosted bottom
  statusbar with live key hints.
- Tally keyboard parity (preventDefault on F-keys): F4 Contra F5 Payment F6 Receipt F7 Journal
  F8 Sale F9 Purchase ^F8/^F9 Cr/Dr note · F2 date · ^A post · Esc back · Alt+C inline-create · ? overlay.

## PHASES (each: tests+smoke+lint+build green → commit "RVOS-002 P<n>: …" → update HANDOFF.md)
P1 foundation: src/lib/fy.ts (Apr–Mar FY math) + src/lib/coa.ts (ACCOUNT_GROUPS, BS sections,
   entity-conditional labels) + db.ts ensureColumns (accounts.group_code; settings entity_type/pan/tan/
   it_regime/presumptive/books_locked_through/fy_audit_case) + SEED_ACCOUNTS extension
   (1500-1590 fixed assets, 2300 TDS Payable, 3100 Capital, 3150 Drawings, 5800 Depreciation)
   + COA CRUD page + settings fields + Apple-ERP shell (globals.css tokens, topbar, statusbar,
   sidebar groups+collapse) + smoke count fix (SEED_ACCOUNTS.length — same commit).
P2 statements: trialBalance(asOf?) · profitAndLoss(month|{from,to}) · balanceSheet(db,asOf,settings)
   with COMPUTED retained-earnings injection (never posted) + A=L+E throw · BS page (segmented tab)
   · fy-select component · export cases.
P3 vouchers+keys: src/lib/vouchers.ts postManualVoucher (structured kinds→buildLegs; contra builder;
   journal→explicit legs) · assertNotLocked in postDocument tx · voucher form (kind switch, leg grid,
   live Dr/Cr, key rail) · src/lib/keymap.ts (pure, tested) + shortcuts provider + ? overlay.
P4 excel import: format.ts rupeeStringToPaise (exact, no floats) · import-csv.ts (RFC-4180, template
   headers date|particulars|ref_no|party|entry_type|debit|credit|gst_rate|settle_account; bad rows land
   include=0 + reason) · documents.source_type + staged_rows.party_id (ensureColumn; photo path
   bit-identical via row.party_id ?? doc.party_id) · template+upload routes · imports page · review-table
   party column for imports.
P5 tally import: dep fast-xml-parser (THE only new dep) · import-tally.ts parseDayBook (Day Book XML →
   frozen 8-type enum; complex journals → excluded "post manually via Vouchers") · ledger_mappings table
   (name→account|party, persistent) · mapping review UI → staged flow.
P6 depreciation: tax/depreciation.ts IT_BLOCKS (10/15/40% WDV) · blockWdv (≥180d/<180d half-rate,
   disposal cap, roll-forward) · fixed_assets + wdv_openings tables · FAR page + block schedule ·
   postDepreciationEntry(fy) Dr5800/Cr1590, one per FY.
P7 income tax: tax/india-it.ts (AY-tagged: slabs old/new, 87A + marginal relief, surcharge+relief,
   4% cess, 288A/B; firm 30%+40(b) ceiling; company 25%/115BAA 22%; 44AD/44ADA; advance-tax
   15/45/75/100) · tax/computation.ts buildComputation (book P&L → dep addback → IT dep → adjustments →
   presumptive branch → tax → payments → schedule) · it_adjustments + tax_payments tables ·
   computation page + stable JSON/CSV export (ITR-schema seam).
P8 tds: tax/tds.ts TDS_SECTIONS (194C/J/I/H, 192B; bp math; no-PAN 20%) · parties.pan ·
   tds_entries (→journal_id) + tds_challans tables · postVoucherWithTds (one tx) · TDS tab: register,
   26Q/24Q CSV prep, challan deposit (Dr2300/CrBank) · voucher-form TDS section picker.
P9 compliance: compliance.ts RULES (GSTR-1 11th, 3B 20th, TDS dep 7th/Mar→Apr30, TDS ret Q-ends,
   adv tax 15 Jun/Sep/Dec/Mar, ITR by fy_audit_case) · generateItems → done|na|pending|overdue ·
   compliance_marks table · FY board page (skip rules w/o gstin/tan/activity).
P10 ca pack: /pack?fy= print-composed bundle (cover → BS → P&L → computation → GST 12-mo → TDS+challans
   → dep schedule → debtors/creditors annexure) from EXISTING fns only · @media print (white, page
   breaks, no chrome) · README/EVOLUTION/HANDOFF final.

## SHIP GATE
npm test + smoke + lint + build green → code-reviewer agent (full branch diff, zero blockers) →
qa-runner agent (drives :3322 DEMO_MODE=1 through entity switch→COA→voucher incl. F-keys+^A→CSV import→
Tally import→BS→computation→TDS→compliance→pack print, zero blockers) → EVOLUTION #9+ complete →
merge to master (local).

## OUT OF V1
ITR portal JSON / official GSTN schemas (seam only) · .xlsx binary parse (CSV template path) ·
multi-client · hard period close (soft lock only) · Companies-Act dep / MAT / deferred tax ·
26AS/AIS recon · TRACES FVU (CSV prep only) · payroll (192B manual) · 3CA/3CB/3CD · RCM/TCS/composition ·
bill-wise allocation · void/reverse · e-invoice/e-way · theme switcher in real app (single chosen scheme).

## RISKS (mitigations wired into phases)
1 smoke pins 13 accounts → P1 flips to SEED_ACCOUNTS.length same commit.
2 BS imbalance from retained-earnings window → balanceSheet throws + reconcile-to-TB property test.
3 frozen staged CHECK divergence → imports map to 8 values; P4/5 test against original-DDL db.
4 per-row-party ripple → nullable staged_rows.party_id w/ doc fallback; old suites unchanged = regression net.
5 tax-constant drift → single AY-tagged file, pinned boundary cases, "CA to verify" on every output.

## SESSION PROTOCOL
Each session: read HANDOFF.md + this spec → execute exactly ONE phase → green → commit → HANDOFF.md.
At ~60% context mid-phase: HANDOFF.md + stop (global rule). EVOLUTION.md entry (or "no failures") per phase.
Design reference: preview artifact https://claude.ai/code/artifact/60d1d93a-a3a8-4d0a-b873-60877e251699
Full expanded plan (exploration findings + per-phase file lists): ~/.claude/plans/dreamy-skipping-mango.md
