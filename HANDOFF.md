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
- **P6 depreciation** — `src/lib/tax/depreciation.ts`: `IT_BLOCKS` (buildings 10 ·
  furniture 10 · plant 15 · vehicles 15 · computers 40, each pinned to its seed
  COA account) · `daysInUse` (both end days, so 3 Oct is the LAST date still
  reaching 180) · `stepYear`/`blockWdv` rolling the opening forward year on year
  (wdv_openings override wins for its FY and carries after it), additions split
  >=180/<180 days at full/half rate, disposals capped at the block and taken off
  the full-rate pool before the half-rate additions, integer paise via
  roundHalfUp · `depreciationSchedule` (all blocks + totals) ·
  `postedDepreciation` (the FY's entry AND its amount, so the page can spot a
  register that moved after posting). db.ts DDL `fixed_assets` (block CHECK,
  paired disposal CHECKs, timeline CHECKs) + `wdv_openings` (UNIQUE fy+block).
  vouchers.ts: JournalVoucherInput gained optional `entry_type` so a generated
  entry posts through the ONE audited journal path while staying identifiable in
  the day book. actions `createAsset` / `disposeAsset` / `postDepreciationEntry`
  (guard + schedule + post in ONE transaction). `/tax` redirect + tax-tabs.tsx +
  `/tax/depreciation` (block schedule, register, inline dispose, add-asset form)
  + sidebar "4 · Tax & filing" + export `case "depreciation"`. 157 tests (13 new);
  smoke pins Rs 1,00,000 computers mid-year -> Rs 20,000. Review: 2 blockers
  (proceeds leaving a block the asset never entered; disposeAsset missing the
  in-use checks) + 2 warns (double-post race; no schema-level timeline) all
  fixed pre-commit -> EVOLUTION #14.
- **P7 income tax** — `src/lib/tax/india-it.ts`: rate tables keyed by TAX YEAR,
  each carrying `verified` + `source`. `ratesFor()` returns
  `provisional: true` + a caveat when a year has no table of its own (carries
  the latest earlier one forward but NEVER silently), and THROWS for a year
  before the earliest table. Pure fns: `slabTax`, `taxForIndividual` (rebate
  with its marginal relief), `surchargeWithRelief` (recursive ceiling — see
  gotchas), `taxForFirm`, `taxForCompany`, `taxFor` (by entity),
  `presumptiveIncome`, `partnerRemunerationCeiling`, `advanceTaxSchedule`,
  `roundToTenRupees`. `src/lib/tax/computation.ts` `buildComputation(db, fy)`:
  book profit -> add back book depreciation (5800) + addbacks -> less the
  Act's block depreciation (P6) + deductions -> GTI -> round -> tax by entity
  -> less payments -> net payable + instalments; presumptive bypasses the whole
  book path. db.ts DDL `it_adjustments` + `tax_payments` (unposted metadata,
  freely deletable). `/tax/computation` page + actions addItAdjustment /
  deleteItAdjustment / addTaxPayment; export `case "computation"` (CSV + the
  stable JSON filing seam); tax-tabs Computation flipped ready and `/tax`
  repointed to it. 186 tests (29 new); smoke pins turnover ₹36,000 -> book
  profit ₹3,500 -> dep bridge nets to nil -> tax NIL -> provisional flagged.
  Review: 2 blockers (marginal relief priced against the wrong baseline, so
  tax FELL as income rose past any threshold after the first; the CSV export
  dropped the provisional caveat) + 1 warn (unused 40(b) ceiling). Wiring the
  40(b) ceiling in to clear that warn introduced a THIRD blocker of its own
  (measured on book profit with depreciation added back, overstating a firm's
  ceiling by the whole charge) — caught on re-review. All fixed pre-commit ->
  EVOLUTION #15.

## Current state
- Branch `feat/rvos-002-accountant-edition`; all four gates green at P7.
- EVOLUTION.md at #15 (P7: price a relief's reference point with the SAME
  function as the thing it caps, and test the PROPERTY — monotonicity —
  not worked examples; qualifying metadata must reach EVERY output format).
- Live-DB compat spot-checked on a COPY of `data/revenueos.db` (+WAL):
  `ledger_mappings` created additively, 6 documents / 27 journal lines intact.
- Live-DB compat also re-checked at P6: `fixed_assets` + `wdv_openings` are
  created additively. NOTE the dev db's `fixed_assets` was recreated once (it
  was empty) so it picked up the timeline CHECKs added after the review —
  CREATE TABLE IF NOT EXISTS never revisits an existing table.
- Both flows were driven end-to-end in a real browser on :3322 — Tally (map →
  stage → review, second import asked zero ledgers, duplicate-bytes banner) and
  depreciation (/tax redirect, add asset, ₹20,000 schedule, post, guard, CSV
  export). All test artifacts were then removed, including the P6 depreciation
  JOURNAL, and the live book verified back to its exact prior baseline (6 docs /
  40 staged rows / 0 mappings / 9 journals / 27 journal lines / 0 assets, TB
  zero). Do NOT expect leftover tally documents or fixed assets there.

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

## OPEN — the rates are not confirmed (carry this into every later phase)
`india-it.ts` ships with EVERY table `verified: false`, so the computation
page, the CSV and the JSON all currently say "rates not confirmed". That is
working as designed, not a bug — but it means the office sees a warning on
every computation until someone checks a year against the Act and flips the
flag. Two things still need a human with the source material:

1. **Confirm FY 2026-27 rates.** The Budget-2025 new-regime ladder is carried
   forward on the basis that Budget 2026 announced no change: nil to ₹4L ·
   5% ₹4–8L · 10% ₹8–12L · 15% ₹12–16L · 20% ₹16–20L · 25% ₹20–24L · 30%
   above ₹24L; rebate ₹60,000 up to ₹12L; surcharge 10/15/25/37 with the new
   regime capped at 25%; cess 4%. Also confirm the firm/company rates, the
   presumptive percentages, and the 40(b) ceiling (₹3,00,000-or-90% on the
   first ₹6L, 60% on the balance — the SPEC's "90% of first ₹3L, min ₹1.5L"
   is the pre-2024 version and was not used). Much published material
   conflates "FY 2026-27" with "AY 2026-27", which is a different year.
2. **Map the section numbers.** The Income-tax Act, 2025 took effect
   1 April 2026 — inside the computed range — and renumbered the 1961 Act;
   sources disagree on where the rebate now sits (156 vs 157). No section
   number appears in any output today and none should be added until this is
   settled. Section labels stay display metadata, never load-bearing.

To confirm a year: add or edit its entry in `TAX_YEARS`, set `verified: true`,
put the citation in `source`. `ratesFor()` and every caveat follow from there.

## Next phase: P8 TDS
Per RVOS-002-SPEC.md §PHASES + dreamy-skipping-mango.md: new
`src/lib/tax/tds.ts` — `TDS_SECTIONS` (194C 1%/2%, 194J 10%, 194I 10%/2%,
194H 2%, 192B manual; basis points + threshold notes — but see the OPEN
section above about section numbering before putting those labels on output),
`computeTds(basePaise, section, hasPan)` (no PAN → 20%), `q26Summary(db, fy,
quarter)`, `q24Summary`. db.ts: ensureColumn `parties.pan`; DDL `tds_entries`
(party_id, section, entry_date, base_paise, tds_paise, journal_id REFERENCES
journals, challan_id) + `tds_challans` (fy, quarter, challan_no, bsr_code,
paid_on, amount_paise). vouchers.ts `postVoucherWithTds` — ONE transaction:
journal (e.g. Dr 5900 ₹10,000 / Cr 2300 ₹100 / Cr Bank ₹9,900) plus the
tds_entries row, rolling back together. Voucher-form gains an optional TDS
section on payment/expense kinds with a live net-payable figure; parties page
and `createParty` gain PAN. New `/tax/tds` page (register, quarterly
summaries + exports, challan form — the deposit posts Dr 2300 / Cr Bank via
postManualVoucher with `entry_type: 'tds_challan'`, which P6 already added
support for — plus missing-PAN warnings). Export `case "tds-26q"` and
`"tds-24q"`. Flip the TDS tab in tax-tabs.tsx to `ready: true`.
Accept: `test/tds.test.ts` — basis-point math exact, no-PAN 20%, quarterly
grouping via `quarterOf`, ATOMICITY (a forced tds_entries failure must leave
no journal behind), challan deposit zeroes account 2300. Smoke: a 194C
voucher → ₹100 in 2300 pinned → 26Q shows one row → challan → 2300 back to
zero, TB zero. Commit: `RVOS-002 P8: tds — section rates, deduct-on-voucher
register linked to journals, challan tracking, 26Q/24Q prep exports`.

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
- A pooled aggregate (depreciation block, batch, control total) must gate ENTRY
  and EXIT on the SAME predicate — cost enters a block only when the asset is
  put to use, so proceeds may leave only then. An asymmetry silently misstates
  every OTHER member of the pool (EVOLUTION #14).
- `CREATE TABLE IF NOT EXISTS` never revisits an EXISTING table, so a CHECK
  added to a table that already shipped is a no-op on every live db (spec risk
  #3). Either recreate the (empty) table deliberately, or make the code hold
  the invariant on its own — P6's engine test runs against a fixed_assets
  recreated WITHOUT the timeline CHECKs for exactly this reason.
- A derived figure displayed beside a POSTED one must be reconciled against it
  and flagged when they differ — /tax/depreciation compares the recomputed
  schedule to the posted journal's own amount (EVOLUTION #14). Applies to P7
  computation and P10's CA pack.
- Generated journals (depreciation, later TDS challans) post through
  postManualVoucher with `entry_type` set on JournalVoucherInput — ONE audited
  posting path, still identifiable in the day book. Don't add a second inserter.
- postManualVoucher opens its own transaction; better-sqlite3 nests these as
  savepoints, so a caller may wrap check-and-post in one db.transaction() to
  make a guard atomic (postDepreciationEntry does).
- A cap/relief/floor computed against a REFERENCE POINT must price that
  reference with the SAME function that prices the thing being capped. P7's
  surcharge relief priced its ceiling as bare slab tax while the liability
  included surcharge — identical at the first threshold, divergent at every
  one after, and tax FELL as income rose (EVOLUTION #15).
- Test the PROPERTY a rule guarantees, not worked examples. Monotonicity
  (more income never means less tax) caught the above instantly; nine pinned
  boundary numbers did not. Reach for a property test on any monotone or
  conservation-style invariant.
- Qualifying metadata ("provisional", "unconfirmed", "as-of") must reach EVERY
  output format. P7's caveat made the page and the JSON but not the CSV — the
  artefact most likely to be pasted into a workpaper (EVOLUTION #15). When
  adding a qualifier, enumerate the renderings and check each.
- `surchargeWithRelief` recurses one tier down to price its ceiling; it
  terminates because tiers apply STRICTLY above their bound. Keep that strict
  comparison or it will not terminate.
- Tax rates live ONLY in `india-it.ts`, keyed by tax year with `verified` +
  `source`. Never inline a rate elsewhere, and never let a missing year fall
  through to last year's numbers without `provisional: true` travelling with
  the result.
- The 40(b) ceiling on /tax/computation is INDICATIVE and never auto-applied:
  it is measured on net profit per the P&L and cannot see remuneration already
  debited there (which the statute adds back first). Don't turn it into a
  silent cap.
- A fix written to clear a review finding is new code — re-review it, and test
  the case that makes its decision visible. P7's only warn was an unused
  function; wiring it in introduced a worse defect than the warn (EVOLUTION
  #15). Prefer deleting dead code to inventing a use for it.
- Money-adjacent diffs: code-review before commit (caught real bugs P2+P3+P4+P5).
- Pinned demo BS figures (postedDb, 2027-03-31): assets 2,158,000p =
  liabilities 558,000p + equity 1,600,000p; profit 1,100,000p; AR 1,258,000p.
  Smoke's CSV leg posts in 2026-08, the Tally leg in 2026-09 and the
  depreciation entry on 2027-03-31 — ALL after these assertions run, so the
  July GST + BS pins stay untouched. Any new smoke leg must post after them
  too, or re-pin the figures deliberately.

## Files touched (P7)
src/lib/tax/india-it.ts (new) · src/lib/tax/computation.ts (new) ·
src/app/tax/computation/page.tsx (new) ·
test/india-it.test.ts (new) · test/computation.test.ts (new) ·
src/lib/{db,types,actions}.ts · src/components/tax-tabs.tsx ·
src/app/tax/page.tsx · src/app/api/export/[report]/route.ts ·
scripts/smoke.ts · EVOLUTION.md · HANDOFF.md
(P6 touched: src/lib/tax/depreciation.ts, src/app/tax/depreciation/page.tsx,
src/components/{tax-tabs,sidebar}.tsx, test/depreciation.test.ts,
src/lib/{db,types,fy,vouchers,actions}.ts.)
(P5 touched: src/lib/import-tally.ts, src/components/import-tally.tsx,
src/app/api/import/tally/preview/route.ts, test/import-tally.test.ts,
src/lib/{db,types,posting,actions}.ts, src/app/imports/page.tsx, package.json.)
