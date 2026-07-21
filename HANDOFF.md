# RVOS-003 HANDOFF (client delivery) — ACTIVE

Branch `feat/rvos-003-client-delivery`, off master `76f023a`. Spec:
`RVOS-003-SPEC.md`. Research: `RVOS-003-P1-FINDINGS.md`. Local only, unpushed.

Delivery target (decided 2026-07-21): office's own **Windows** machine, ONE
company, **client's own** `claude` CLI subscription, reachable over **their
Tailscale**.

## DONE
- **P0** `fc75d40` — spec, 6 phases, 3 new invariants (auth before any
  non-localhost bind · a backup counts only when a RESTORE is asserted ·
  Windows claims ship WINDOWS-UNVERIFIED until run on their machine).
- **P1 research** `14d1783` — 4 agents vs primary gazette text. **No flag
  flipped.** Findings in `RVOS-003-P1-FINDINGS.md`. Headline: the FY 2025-26
  numbers were already CORRECT; what is broken is the METADATA.
- **P2 foundation** `1343866` — schema, auth core, DAL, proxy, login page.
  227 tests pass, tsc clean.

- **P2 guards wired** `719e362` — 20 actions + 7 handlers + 22 pages, logout,
  session-gated chrome, +30 tests.
- **P2 open-redirect fix** `76c8590` — see gotchas. Found by the zero-context
  review, not by me.

- **P2 session sweep + EVOLUTION #20-#22** `eef5b82`.
- **P2 proxy /api 401 fix** `e7f863b` — found by qa-runner.

**P2 IS COMPLETE, ship gate passed.** 267 tests · smoke GREEN · lint · tsc ·
build. Zero-context code-reviewer on the full branch diff: 1 blocker (open
redirect, fixed in `76c8590`), nothing else; it re-walked the router itself
rather than trusting the diff. qa-runner drive of :3322: 1 failure (proxy
answering /api with 307 instead of 401, fixed in `e7f863b`), nothing else —
anonymous pages leak no ledger data, cookie is HttpOnly/Lax/no-Secure, all
three open-redirect payloads land on /, accounting output unchanged behind
auth, `data/revenueos.db` restored byte-identical (sha256 da63a52b… both ends).

**The P2 lesson worth keeping:** the code reviewer and the unit tests both
reason about code AS WRITTEN. Only the HTTP drive could show that the API
handlers were CORRECT but UNREACHABLE — the proxy answered first and rewrote
every 401 into a 307. `route-guards.test.ts` is static and proves a handler
WOULD answer 401 if reached, never that a request arrives. `test/proxy.test.ts`
now closes that gap.

- **P3 backups + WAL checkpoint** `962d157` — see EVOLUTION #23; this one
  found and recovered a real ledger loss.
- **P4 Windows install path** `e43ce97` — WINDOWS-UNVERIFIED.
- **P5 bind policy** — loopback default, tailnet opt-in, 0.0.0.0 refused.

- **P6 docs** — `docs/DAY-ONE.md` + README corrected.

## NEXT (in this order)
1. **P1 metadata work** — see the P1 section. Researched, no code changed. This
   touches TESTED, money-adjacent tax code and deserves a FRESH context window,
   not the tail of a long one.
3. Merge to master only after the full gate; master is untouched at `76f023a`
   and still shippable. **The branch exists only on this disk** —
   `git push -u origin feat/rvos-003-client-delivery`.
4. **Windows acceptance with Pranav present** clears invariant N3 — install
   from clean, reboot, sign in over the tailnet, restore a backup, extract one
   real photo on the OFFICE's claude account. Nothing before that step may be
   reported as Windows-ready.

## P3/P4/P5 — decisions worth not re-litigating
- Backups go through SQLite's ONLINE BACKUP API, never a file copy.
  `verifyBackup` probes the accounting tables and asserts journal lines
  balance — `integrity_check` alone passes a zero-byte or foreign database.
- `configureConnection()` checkpoints the WAL on every open and sets
  `wal_autocheckpoint = 64`. Do not remove either: see EVOLUTION #23.
- Uninstall deliberately LEAVES `data/`. An uninstaller that deletes
  accounting records is a disaster with a progress bar.
- All installer pass/fail DECISIONS live in `src/lib/preflight.ts` and are unit
  tested. PowerShell orchestrates and reads an exit code — logic in a .ps1 is
  logic nothing has ever tested.
- The `claude` CLI check verifies PRESENCE only and says so; proving sign-in
  costs a real request. It is non-fatal and names what still works without it.
- Bind defaults to loopback. Tailnet (100.64-100.127.x.x) is an opt-in via
  `REVENUEOS_BIND`; 0.0.0.0 and public-looking hosts are REFUSED unless
  `REVENUEOS_ALLOW_ANY=1`.

## P2 — decisions worth not re-litigating
- Sessions are a TABLE, not a signed stateless cookie, because a signed cookie
  cannot be revoked and "revoke access" is a real requirement for an office.
- Only SHA-256 of the token is stored, so a copied db (backup, Syncthing,
  stolen laptop) yields no usable cookie. Pinned by a test that greps the row
  dump for the raw token.
- The lockout counter is PERSISTED. In-memory would be cleared by the restart
  that autostart-at-logon performs.
- NO default credentials. First run turns /login into a create-account form,
  guarded on `userCount() === 0`.
- Chrome is session-gated in the root layout as PRESENTATION only (the topbar
  prints company name + GSTIN). Pages still guard themselves — a layout does
  not re-render on navigation.

## GOTCHAS (P2)
- **Next 16 renamed Middleware → Proxy.** `middleware.ts` does not exist; the
  file is `src/proxy.ts`. Proxy runs on the **Node** runtime by default here.
- **Proxy is optimistic ONLY.** It must not read the db — it runs on every
  request including prefetches. A forged cookie passes proxy and is rejected by
  the DAL. That is the design, not a hole.
- **Server Functions are POSTs to the route that uses them.** A proxy matcher
  that skips a path also skips its actions, and moving an action to another
  route silently removes coverage. Never rely on proxy for an action.
- **The docs' `secure: true` cookie is WRONG for this deployment.** The office
  reaches the app as plain `http://100.x.x.x:3322`; a Secure cookie is silently
  dropped on a non-HTTPS origin and login loops forever with nothing in the
  logs. Gated behind `REVENUEOS_HTTPS=1` for when TLS is terminated in front
  (`tailscale serve`).
- **Layouts do not protect nested routes** (Partial Rendering — a layout does
  not re-render on navigation). Check per page, never in the layout.
- `server-only` is NOT a dependency and must not become one; both imports were
  removed. better-sqlite3 + `next/headers` already fail loudly in a client
  bundle.
- `cookies()` is **async** in Next 16 — await it, like params/searchParams.
- No default credentials ship. First run turns /login into a create-account
  form, guarded on `userCount() === 0`.
- Design tokens: `ink ink-2 ink-3 surface surface-2 hairline accent critical
  warning`. There is **no** `shadow-whisper` utility — I invented it once and
  had to remove it. Cards are `rounded-xl border border-hairline bg-surface p-5`.
- `grep` silently returns NOTHING in this sandbox (even `grep -c`) while exit
  codes still work — several searches came back falsely clean. Use `sed -nE`
  or the Read tool. BSD `sed` also rejects `\?`; use `-E`.
- **Never pattern-match a string a browser will later PARSE.** `safeNext()`
  rejected a leading `//` but not a leading BACKSLASH, and the WHATWG URL
  parser normalises `/\evil.com` → `//evil.com` → `http://evil.com/`. Because
  /login is public, the payload arrived on a link to our OWN login page and
  fired AFTER the victim authenticated. Now resolved against a reserved
  sentinel origin with an origin equality check (`safeNextPath` in auth.ts).
  The parser's normalisation rules ARE the attack surface.
- A `"use server"` module may only export ASYNC functions — that is why
  `safeNextPath` lives in `auth.ts` and not beside its caller. Anything in an
  actions file that needs a unit test has to move out of it.
- `requireSession()` works by THROWING a redirect. Any `try`/`catch` around a
  guarded call site can swallow it and let the request continue
  unauthenticated — `runExtraction` opens with `try {`, so its guard sits
  ABOVE the try. Check this on every new action that catches broadly.
- ESLint's `react-hooks/rules-of-hooks` fires on ANY function named `use*`,
  including plain server helpers. `useSecureCookie` had to become
  `wantSecureCookie`.

## GOTCHAS (P3/P4/P5)
- **A `.db` file is not the database.** See EVOLUTION #23 — the live ledger was
  lost because all data sat in an uncheckpointed `-wal` while `revenueos.db`
  was a 4 KB stub, and a sha256 of that stub "verified" the loss as unchanged.
  Never hash/copy/move/delete a `.db` without its `-wal`/`-shm`, and assert
  CONTENT (row counts, trial balance), never byte-identity of one file.
- **`next start` binds 0.0.0.0 by default** — every interface, every network
  the machine joins. `npm run start` now goes through `scripts/start.ts`, which
  applies `src/lib/bind.ts`. Do not "simplify" it back to a bare `next start`.
- `npm run dev` was left binding 0.0.0.0 ON PURPOSE — Pranav's phone capture
  over Tailscale depends on it. Only production `start` is locked down.
- **PowerShell treats a backtick as an ESCAPE inside double-quoted
  here-strings**: `` `t `` becomes a TAB. Writing `` `tailscale ip -4` `` in a
  `@"..."@` block silently corrupts the text. Use plain quotes; the only
  legitimate backticks in setup.ps1 are `` `n ``, line continuations and
  escaped quotes.
- ESLint forbids `require()`. `checkNativeModule` still needs a LAZY load (a
  static import throws during module evaluation, so an ABI mismatch would
  crash the preflight instead of printing its fix) — use `createRequire`.
- `statfsSync` needs Node 18+; it is how disk headroom is checked.
- **Accounts Payable is code 2100, not 2000.** Verify seed codes against
  `SEED_ACCOUNTS` in db.ts before writing them into docs — I nearly shipped
  2000 into the day-one runbook. Opening balances post fine as a free-form
  journal with `entry_type: "opening"` (verified: day book shows "opening",
  TB net 0, BS 1,70,000 = 30,000 + 1,40,000).

## P1 — what it actually needs (NOT a boolean flip)
Detail in `RVOS-003-P1-FINDINGS.md`. Three metadata defects, one per file:
- `tds.ts` cites only ITA 2025 s.393 and is `verified: true` unconditionally —
  on an FY 2025-26 screen that cites an Act which did not govern the year. The
  VALUES are identical across both years (each primary-verified against a
  different gazette), so this needs an **authority axis, not a value axis** —
  much cheaper than SPEC risk R2 assumed.
- `compliance.ts` same, plus names Forms 140/138 while `:191` renders the
  contradicting string `"26Q/24Q statement"`. FY 2025-26 files on 26Q/24Q.
- `india-it.ts` `verified` is ONE boolean over ~15 fields, but the research
  verified some and REFUSED others (44AD/44ADA/44AE — presumptive rates rest on
  search snippets). Flipping it would claim verification nobody performed.
  → verification metadata must live per FIELD-GROUP and per YEAR.
- Resolved: HANDOFF open item #2. FA 2026 s.5 substituted Expln 2 to s.139(1)
  of the **1961** Act w.e.f. 1 Mar 2026, so the 31 Aug tier reaches FY 2025-26,
  and its discriminator ("business/profession income, accounts not audited")
  covers a non-audited **firm**. `compliance.ts:232` gates on
  `proprietorship && y >= 2026` — wrong on both axes; fails safe.
- Known gap with a number on it: `company_rate` is always 25%, but 25% requires
  turnover ≤ ₹400cr **in PY 2023-24** — above that it is 30%, so large
  companies are under-taxed. Documented at `india-it.ts:107`.
- **Adversarial re-check has NOT run.** Nothing flips to `verified: true`
  before it does (EVOLUTION #19 protocol).

## EVOLUTION candidates from this build (not yet written)
- A primary source can serve a STALE VERSION at a live URL. The ITD hosts
  multiple versions of a section at near-identical slugs and the obsolete ones
  rank HIGHER in search; an agent cited pre-1994 s.234C (1.5%) before catching
  itself. "Use a primary source" is insufficient — pin the version id and
  cross-check against a second host.
- A brief's own premises are not evidence. Two premises I wrote into the spec
  were wrong (FA 2025 did not raise the 194C thresholds; the s.40(b) revision
  was Finance (No.2) Act 2024). Both would have been written into `source`
  fields as fact.

---

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
- **P8 tds** — `src/lib/tax/tds.ts`: `TDS_SECTIONS` (194C 1%/alt 2% · 194J
  10%/alt 2% · 194I 10%/alt 2% · 194H 2% · 192B manual; basis points,
  thresholds, per-section `verified: false` that surfaces in every
  computation's warnings), `computeTds` (no-PAN penal 20% as a FLOOR;
  thresholds warn, never auto-skip — the aggregate annual test is the
  office's), `tdsRegister`, `q26Summary`/`q24Summary` (payee+section grouping,
  missing-PAN flags, undeposited). vouchers.ts `postVoucherWithTds` — ONE tx:
  Dr expense gross / Cr 2300 / Cr settle net + the register row pointing at
  the journal (rate_bp stores the EFFECTIVE rate on an override); zero-TDS and
  full-TDS edges never emit a zero-amount leg. db.ts: `parties.pan`
  (ensureColumn) + DDL `tds_entries` (journal_id NOT NULL) + `tds_challans`
  (journal_id NOT NULL — live table recreated for it). actions
  `createTdsVoucher` + `createTdsChallan` (per-FORM deposit 26Q|24Q, amount
  computed never typed, one tx: journal + challan + stamp). `/tax/tds` page
  (deduct form, quarterly 26Q/24Q cards, challan form w/ Covers selector,
  missing-PAN + unverified-rates banners), parties page + createParty PAN
  (format-validated), export `case "tds-26q"/"tds-24q"` (CSV leads with the
  caveat). 203 tests (16 new incl. atomicity: a sabotaged register insert
  leaves NO journal). Smoke: 194C ₹10,000 → ₹100 in 2300 → 26Q one line →
  challan → 2300 zero, TB zero (posts 2026-10, after every earlier pin; the
  demo payee gets a PAN first or the penal 20% correctly fires). Review:
  0 blockers, 3 warns (audit trail: override rate_bp, nullable challan
  journal, mixed-form challans) all fixed + pinned; re-review added the
  `tds_challans.form` column (a quarter can hold a 26Q and a 24Q challan and
  the rows must be distinguishable) -> EVOLUTION #16.

- **P9 compliance** — `src/lib/compliance.ts`: `RULES` (gstr1 11th ·
  gstr3b 20th · tds-deposit 7th-next-month with Mar→Apr 30 · tds-return
  Jul 31/Oct 31/Jan 31/**May 31 in the NEXT FY** · advance-tax 15
  Jun/Sep/Dec/Mar · itr Jul 31 / Oct 31 by fy_audit_case), every rule
  `verified: false` + source, same law-adjacent discipline as india-it.ts.
  Pure `dueItems(fy, {gst, tds})` + `itrItem(fy, auditCase)`;
  `generateItems(db, fy, settings, today)` merges `compliance_marks`, derives
  pending/overdue from the INJECTED today (strictly due_date < today; due
  today = pending), sorts by due date. Period keys: months absolute
  ("2026-04"), quarters/ITR FY-prefixed ("2026-27-Q4", "2026-27") so marks
  never collide across FYs under UNIQUE(rule_code, period). GST rules iff
  gstin set; TDS rules iff TAN set OR tds_entries exist in the FY (books
  with real deductions owe returns before settings catch up). db.ts DDL
  `compliance_marks` (status CHECK done/na, UNIQUE(rule_code, period)) —
  verified additive on a live-db copy. Action `markCompliance`
  (done/na/clear; upsert ON CONFLICT; validates the pair against
  **generateItems with the real settings** — see EVOLUTION #17).
  `/compliance` page: FY select, month-grouped-by-DUE-date board, status
  pills (dot pattern), per-row note + Done/N-A/Clear, caveat banner gated on
  unverified rules, hidden-regime hints. Sidebar entry under "4 · Tax &
  filing" (own nav item, NOT a tax-tabs tab). 221 tests (17 new: pinned
  45-item full board = 24 GST + 16 TDS + 4 AT + 1 ITR; Dec→Jan seam;
  Q4→May 31 next FY; membership independent of today; marks override;
  regime skips incl. deduction-without-TAN). Smoke: 21-item board leg
  (TDS auto-on via posted deduction, GST off), mark → regenerate → done,
  sibling overdue, TB untouched. Review: 1 blocker (validation allowlist
  built from a superset — both regimes hardcoded on) fixed pre-commit; the
  FIX then failed its own adversarial re-review on the FY axis (format-only
  fy check vs the page's fyList clamp — reproduced live) and over-gated
  clear (wrong marks trapped when a regime switches off). Marking now
  validates fy ∈ fyList(db) + engine membership; clear requires only that
  the mark exists → EVOLUTION #17. Warn (blanket banner) fixed by gating.

- **P10 CA pack** — `src/app/pack/page.tsx` (`?fy=`): cover (company,
  entity, FY, PAN/TAN/GSTIN, regime, contents, pack-level provisional
  banner) → BS → P&L → Computation (row-for-row parity with
  /tax/computation incl. its caveat, payments itemised, advance-tax table,
  40(b) note) → GST 12-month gstr3b sweep + totals → TDS quarterly 26Q/24Q
  totals + challans + undeposited line → depreciation block schedule + FAR
  (+ drift/not-posted banners) → debtors/creditors annexure. Composed 100%
  from existing fns; only row-enumeration SQL (parties/challans/assets,
  same as existing pages). `print-button.tsx` client comp; globals.css
  gained the app's first `@media print` block (`--sidebar-w:0` collapses
  the shell, chrome `display:none`, white/black, `print-color-adjust:
  exact` so caveat banners survive onto paper, `tr { break-inside: avoid }`,
  sections `print:break-before-page`). **Engine change:** `partyStatement`
  gained optional INCLUSIVE `asOf` dating BOTH ledgers (named @params;
  omitted = byte-identical, pinned by deepEqual test); gstr3b's itc_paise
  normalises `-0`. **Annexure lists BOTH sides of every party** — own
  ledger on its own side, cross-ledger tagged on the side it sits — and a
  critical banner fires if totals don't tie to the BS AR/AP lines. The
  smoke reconciliation assert caught the first (own-ledger-only) version
  hiding a customer's ₹3,900 payable → EVOLUTION #18. Smoke pack leg:
  annexure==controls, 12-month sweep, caveats travel, schedule==posted.
  222 tests. Review: 0 blockers, 3 cosmetic warns (tax-block parity,
  presumptive tag, dead print rule) fixed + re-verified. Print preview
  checked via headless-shell PDF: 8 pages, one section each, no chrome,
  white, banners printed. README: Accountant Edition section + refreshed
  Deferred list.

## Current state
- Branch `feat/rvos-002-accountant-edition`; all four gates green at P10.
- EVOLUTION.md at #18 (P10: write a new view's reconciliation-to-control
  assert FIRST — a summary can look complete while omitting a whole class
  of rows; past lessons attach to the DATA SHAPE, not the page they were
  learned on).
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

## OPEN — verification state (FY 2026-27 VERIFIED 2026-07-21)
The 2026-27 rate table, all five TDS sections and all six compliance rules
are `verified: true` with gazette/portal citations in their `source` fields
(EVOLUTION #19 records the protocol and what it caught: 194J ₹50k and 194I
₹50k/month threshold corrections, Form 140/138 renumbering, the 31-Aug ITR
tier, presumptive single-instalment advance tax, rebate = s.156). Banners
are driven by the flags, so the verified year renders caveat-free while any
unverified year still warns everywhere.

Still open, deliberately:
1. **2025-26 stays unverified** — a 1961-Act year assembled from secondary
   sources; computations for it keep their caveat until someone checks it
   against THAT Act's schedule. Same flip protocol applies.
2. **Partnership ITR-5 and the 31-Aug tier** — the verified claim covers
   ITR-3/4 (business/professional non-audit); whether a firm's ITR-5 gets
   31 Aug is unpinned, so a partnership's board shows the safe 31 Jul.
   Pin it from s.263(1)(c)'s exact wording and widen itrItem if it applies.
3. **Not modelled** (documented gaps, not errors): 15% surcharge cap on
   dividend/s.196-198 capital-gains income (no special-rate income in the
   app); salary standard deduction (₹75k new / ₹50k old); GSTR-9/9C annual
   return rule (due 31 Dec of the next FY — worth adding to compliance);
   QRMP filing dates; TDS on partner remuneration (old 194T — matters for
   partnership clients); due-date EXTENSIONS by notification are not
   tracked.

To confirm a year: add/edit its `TAX_YEARS` entry, set `verified: true`,
put the citation in `source`. `ratesFor()` and every caveat follow. Same
pattern per TDS section and compliance rule.

## SHIP GATE: PASSED — merged to master 2026-07-20 (`a0b76ee`)
1. ✅ npm test (222) + smoke + lint + build green at P10 (`a8dc04b`).
2. ✅ code-reviewer on the FULL branch diff: 0 blockers. Confirmed
   independently: one audited posting path, inclusive books-lock at all
   three entry points, additive-only migrations, exact string→paise on all
   file data, caveats reach every output incl. the pack, allowlists derived
   from the rendering engines, no SDK/API-key, only new dep fast-xml-parser.
3. ✅ qa-runner drove :3322 (DEMO_MODE=1, fresh server): 0 failures across
   settings/COA-add/voucher→day-book→TB-balanced/CSV import/Tally preview/
   BS/computation/TDS/compliance/pack (all 8 sections + banners, no -₹0.00,
   annexure tied out silently even WITH the QA run's own new activity).
   Keymap verified via its unit suite (client-side keys can't be curl'd).
4. ✅ EVOLUTION #10–#18 complete.
5. ✅ `git merge --no-ff` → master `a0b76ee`; master re-verified (222 tests
   + SMOKE GREEN post-merge). LOCAL only — no remote exists; local disk is
   the only copy.
Live db restored byte-identical after QA (sha256 match) and the QA run's
two orphan upload files removed; dev server restarted on :3322.

## Future hardening (reviewer notes, explicitly non-blocking)
- `coa.ts` SEED_GROUPS duplicates group_codes already inlined in db.ts
  SEED_ACCOUNTS and is only self-tested — collapse to one source of truth.
- `settings.entity_type / it_regime / presumptive` rely on server-action
  validation with no SQL CHECK (unlike documents.source_type). Add CHECKs
  if any non-action write path to settings ever appears.

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

- A validation allowlist must come from the SAME function + inputs that
  rendered the choices (settings, db state). A superset ("any configuration
  could show this") re-opens the bypass EVOLUTION #11 closed — and check
  EVERY axis the form filters, including the validator's own arguments
  (markCompliance's fy had to be clamped to fyList(db) exactly like the
  page, not just format-checked). Guards are directional: create/assert
  validates against the rendered world, delete-own-metadata validates
  against existence only, or wrong marks get trapped behind a switched-off
  regime. When the validator calls a generator with an input it doesn't
  strictly need (the clock), pin with a test that the input can't change
  the generated SET (EVOLUTION #17 — test "board membership is independent
  of today").
- addItAdjustment / addTaxPayment / createTdsChallan also fy-format-check
  only (pre-#17 precedent). Lower stakes — their rows are visible, deletable
  metadata, not completion claims — but if one ever grows an assertion
  semantic, clamp its fy to fyList(db) the same way.
- Compliance period keys: months are absolute ("2026-04"); anything
  FY-scoped (quarters, ITR) carries the FY prefix. New rules must follow or
  marks collide across FYs under UNIQUE(rule_code, period).
- compliance_marks stores ONLY human marks (done/na); pending/overdue are
  derived every render. Never persist a derived status.
- Regime switches live in generateItems, not the page: GST iff gstin,
  TDS iff TAN OR tds_entries-in-FY. The page's "rows hidden" hints re-derive
  from the same predicates via the items themselves.

- `partyStatement(db, id, asOf?)`: asOf is INCLUSIVE and dates BOTH the own
  ledger and the cross ledger; omitted = full history, byte-identical.
  Never mix date bases inside one composed view (EVOLUTION #18).
- Any new view over party balances must list BOTH sides (own + cross) or
  its totals will not tie to the AR/AP controls — the statement page and
  the pack annexure are the two implementations; keep them in agreement.
- The pack renders each section with the SAME functions and the SAME
  row-set conditions as the section's live page — parity is a review
  criterion, not a nicety (P10 warn). New pack sections must mirror their
  page, and new page caveats must be added to the pack the same commit.
- @media print lives at the END of globals.css: chrome hides via
  `--sidebar-w: 0` + display:none on `.sidebar` / `.content-shell > header`
  / `.statusbar-shell`; `print-color-adjust: exact` keeps caveat tints on
  paper. New chrome components must be added to that hide list.
- gstr3b itc_paise: keep the `|| 0` — a bare negation of an empty SUM
  prints "-₹0.00" on every empty month.

## Files touched (P10)
src/app/pack/page.tsx (new) · src/components/print-button.tsx (new) ·
src/lib/reports.ts (partyStatement asOf, gstr3b -0) ·
src/app/globals.css (@media print) · test/reports.test.ts ·
scripts/smoke.ts · README.md · EVOLUTION.md · HANDOFF.md

## Files touched (P9)
src/lib/compliance.ts (new) · src/app/compliance/page.tsx (new) ·
test/compliance.test.ts (new) ·
src/lib/{db,types,actions}.ts · src/components/sidebar.tsx ·
scripts/smoke.ts · EVOLUTION.md · HANDOFF.md

## Files touched (P8)
src/lib/tax/tds.ts (new) · src/app/tax/tds/page.tsx (new) ·
test/tds.test.ts (new) ·
src/lib/{db,types,vouchers,actions}.ts · src/app/parties/page.tsx ·
src/components/tax-tabs.tsx · src/app/api/export/[report]/route.ts ·
scripts/smoke.ts · EVOLUTION.md · HANDOFF.md
(P7 touched: src/lib/tax/{india-it,computation}.ts,
src/app/tax/computation/page.tsx, test/{india-it,computation}.test.ts,
src/lib/{db,types,actions}.ts, src/components/tax-tabs.tsx,
src/app/tax/page.tsx, export route, smoke.)
(P6 touched: src/lib/tax/depreciation.ts, src/app/tax/depreciation/page.tsx,
src/components/{tax-tabs,sidebar}.tsx, test/depreciation.test.ts,
src/lib/{db,types,fy,vouchers,actions}.ts.)
(P5 touched: src/lib/import-tally.ts, src/components/import-tally.tsx,
src/app/api/import/tally/preview/route.ts, test/import-tally.test.ts,
src/lib/{db,types,posting,actions}.ts, src/app/imports/page.tsx, package.json.)
