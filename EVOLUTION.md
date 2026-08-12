# EVOLUTION — RVOS-001 build log

Every bug or agent misstep during the build, converted into a permanent system
delta (per global CLAUDE.md INTEL-P1).

## 1. Spec gloss vs executable formula (splitCgstSgst)

**What happened:** The ticket's formula (`cgst = roundHalfUp(tax/2); sgst =
tax − cgst`) and its prose gloss ("odd paise → SGST") disagree for odd tax
amounts — the formula gives the extra paise to CGST.

**Resolution:** Implemented the executable formula exactly; read the gloss as
"SGST is the subtraction side, so the pair always reconciles". Unit tests pin
both the invariant (cgst+sgst === tax) and the concrete odd case.

**Delta (spec-template):** When a coded spec carries both a formula and a
prose gloss, the formula wins; record the interpretation next to the
implementation and pin it with a test so the choice is visible, not silent.

## 2. Error-path test hit the wrong guard (posting)

**What happened:** The "included 'other' row must abort the post" test used
fixture row 10 verbatim — which has no amounts, so it tripped the earlier
"exactly one non-zero side" guard and the test failed on the error message.

**Resolution:** Gave the row an amount so the test exercises the 'other' →
unpostable path specifically. One red test run, fixed immediately.

**Delta (test craft):** When a pipeline has layered validations, each
error-path test must construct a fixture that passes every earlier guard so it
provably reaches the guard under test.

## 3. Spec gap: settle account has no channel in the extraction contract

**What happened:** The fixture demands row 6 = `receipt/bank`, but the
verbatim JSON output contract has no `settle_account` field, so a faithful
extraction could never produce it.

**Resolution:** Validator accepts an optional `settle_account` (fixture
carries it) and, when absent, infers `bank` for receipt/payment rows whose
particulars read like bank movements (NEFT/RTGS/UPI/cheque…); default stays
`cash`, and the review grid always has the final say.

**Delta (spec-template):** When a fixture encodes a field the output contract
cannot carry, close the gap in the validator (optional field + conservative
inference), never by silently editing the verbatim contract.

## 4. Top-level await in a tsx-run script (smoke)

**What happened:** `scripts/smoke.ts` used top-level await; with no
`"type": "module"` in package.json, tsx compiles standalone scripts as CJS and
esbuild rejects top-level await — the P7 gate went red on first run.

**Resolution:** Wrapped the flow in `async function main()` + `main().catch`.

**Delta (rule):** In repos without `"type": "module"`, standalone tsx/esbuild
scripts must use a `main()` wrapper, never top-level await — even though
`await import()` inside functions is fine.

## 5. Ship-gate findings (both fixed in-session)

**qa-runner:** `monthLabel("2026-13")` returned `"2026-13 2026"` — the
out-of-range fallback re-appended the year instead of passing the input
through. Fixed; qa-runner's new `test/format.test.ts` adopted into the suite.
*Delta (test craft):* every formatting helper needs a malformed-input
passthrough test, not just happy paths.

**code-reviewer:** party statements filtered to one control account by party
kind, silently dropping legs the same party carries on the other account
(the spec itself posts customer-khata purchases/payments to AP — demo truth:
Sharma carries AR ₹12,580.00 **and** AP ₹3,900.00). The reviewer's proposed
fix (merge both accounts into one statement) would have broken the ticket's
pinned gate figure (statement = ₹12,580.00), so the statement stays a
control-account ledger and the hidden side is surfaced as
`cross_ledger_paise` + `net_position_paise` (party page tiles + export
fields), pinned by tests. *Delta (spec-template):* when a party can appear on
both control accounts, every party-level report must state all three numbers
(ledger closing, cross-ledger, net) — dropping the other side misstates who
owes whom; and when a reviewer's fix conflicts with a pinned gate truth,
resolve by exposing the missing data, not by changing the pinned semantics.

## 6. No other failures

Phase gates P1–P7 otherwise passed first try; server-action-by-curl (P2/P5
gates) worked via the rendered `$ACTION_ID` form field and the `Next-Action`
header respectively.

## 7. Post-ship (2026-07-16): capture quality + bill-type pages (no per-row date)

**What happened:** Real-world use surfaced two gaps the demo fixture hid.
(a) Capture was a bare `capture="environment"` file input that hard-rejected
iPhone HEIC and shipped full-res photos. (b) A user photographed a **BILL FORM**
(itemised invoice: Quantity/Description/HSN/Rate/Value) — not the running khata
the app was designed around. A bill has ONE document-level date, no per-row
dates, so the vision model correctly returned `entry_date: null` on every row —
and the posting engine then blocked with `row 1: needs a date before posting`,
thrown server-side on the FIRST offender only (fix row 1 → re-post → "row 2…" →
N round-trips).

**Resolution:**
- Capture rewritten to normalise every shot in the browser (decode → downscale
  2400px → bake EXIF orientation into pixels → re-encode JPEG q0.85) + preview
  and Retake. HEIC decodes natively on iOS Safari; sideways photos (a silent
  extraction-killer) are made upright before upload.
- Review gained a client-side pre-flight mirroring the posting rule: it flags
  **all** included dateless rows at once, highlights the cells, focuses the
  first, and blocks before the confirm dialog. Server throw kept as backstop.
- Added a **"Fill empty dates"** control (set one date → stamps all empty rows)
  — the correct UX for bill/invoice pages.

**Delta (spec-template):** The extractor was NOT wrong to return null dates — do
not "fix" extraction to invent dates. Ledger-vs-bill is a real document-type
split: khata pages date per row; bills/invoices carry one document-level date.
Any field the source encodes once at the document level (date here; GSTIN,
bill-no next) must be fillable once in review, never required per row — and
per-row posting validation must fail *all* offenders up front, not one at a time.

## 8. Code review of the post-ship capture/fill-dates rewrite (2026-07-17)

**What happened:** A workflow-backed xhigh review of item 7's diff (before
commit) found 8 confirmed defects, none caught by typecheck/lint/tests. Two
were data-integrity bugs: `fillEmptyDates()`/`emptyDateCount` had no
`r.include` guard, so the bulk date-fill silently persisted a fabricated date
onto excluded/balance rows via `payload()` → `applyDraftRows` — a
still-excluded row could later be re-included and posted under an invented
date. The bulk-fill input also defaulted to `rows.find(r => r.entry_date)`,
silently trusting whichever row happened to have a date first, including a
single stray mis-extraction. The rest were UI-integrity gaps in the same
rewrite: Retake called `fileRef.current?.click()` against a ref that was
`null` because the `<input>` only existed in the DOM in the no-preview
branch; the "Row N needs a date" banner was a string snapshotted at click
time that `clearDateFlag()` never updated, so it kept naming already-fixed
rows; every image was forced through a lossy JPEG q0.85 re-encode even when
already small and clean; a transparent PNG composited to solid black under
that re-encode (no background fill before `drawImage`); the image-decode
promise had no timeout, so an undecodable file could hang "processing"
forever; and `createObjectURL` ran inside a `setShot` functional updater,
which Strict Mode double-invokes in dev, leaking a blob URL per pick.

**Resolution:** All 8 fixed — see `src/components/review-table.tsx` and
`src/components/upload-capture.tsx` in this commit. Fixes: gate
fill/count on `r.include`; default `fillDate` to `""` (no auto-trust); derive
the missing-dates banner live from the `missingDates` set instead of a frozen
string; mount the file `<input>` unconditionally (`htmlFor` instead of
physical nesting under the label) so Retake always has a live ref; seed an
opaque white canvas background before `drawImage`; only drop to JPEG q0.85
when actually downscaling (0.95 otherwise); add a 15s decode timeout with a
user-facing error; hoist `createObjectURL` out of the updater so it runs
exactly once per pick.

**Delta (spec-template):** A feature rewrite that touches capture/review UI
state needs an adversarial code review before commit, not just
typecheck/lint/tests — none of these 8 were type errors or lint violations,
and several (fabricated dates on excluded rows, silent stray-date trust) are
exactly the class of bug a coded spec's "hard constraints" section exists to
prevent. Add "run /code-review before committing" as a standing step for any
diff touching money-adjacent UI state (dates, amounts, include flags), not
just before a ship gate.

## 9. RVOS-002 P1 (2026-07-19): no failures

All four gates green first run (87 tests, smoke with 23 grouped accounts,
lint, build), live-DB copy migrated cleanly through the new ensureColumn
slots. High-effort code-review workflow launched on the diff; committed on
Pranav's go-ahead with any late findings to land as `RVOS-002 gate:` commits.

## 10. RVOS-002 P2 (2026-07-19): reused `?N` SQL params bound positionally

**What happened:** `trialBalance(asOf?)` and `profitAndLoss(period)` reused
numbered SQLite parameters (`?1` twice for the null-or-filter idiom) and bound
them positionally with `.all(a, b, c)`. better-sqlite3 refuses positional
binding when a numbered param is reused — every call threw
`RangeError: Too many parameter values were provided`, failing 10 tests.

**Resolution:** switched all three optional-filter queries in reports.ts
(`trialBalance`, `profitAndLoss`, `netProfitBetween`) to `@named` params bound
with a single object — better-sqlite3's supported form for reused params.

**Delta (rule):** in this repo, any SQL parameter that is optional (the
`@p IS NULL OR col = @p` idiom) or referenced more than once MUST be a
`@named` param bound via an object; never `?N` with positional args.

## 11. RVOS-002 P3 (2026-07-20): server trusted the form's party filter

**What happened:** `postManualVoucher`'s structured branch looked the party up
but never checked its kind against the voucher kind — the client `<select>`
filters customers vs suppliers, so the gap was invisible in the UI, but a
direct server-action call could post AR entries against a supplier (or AP
against a customer), corrupting both sub-ledgers. Caught by the pre-commit
code-review pass, not by tests — all 109 tests went through the form's happy
path.

**Resolution:** kind guard in `legsFor` (sale/receipt/credit_note → customer;
purchase/payment/debit_note → supplier) + a pinned rejection test.

**Delta (rule):** any option a form *filters* is a constraint the server must
*enforce*: every server action that accepts an entity id must re-validate the
relationship the UI implied (party kind, account group, document status) —
client-side filtering is UX, never validation.

## 12. RVOS-002 P4 (2026-07-20): name-keyed lookup silently last-write-won

**What happened:** the CSV importer resolved the template's `party` column via
a `Map` keyed by lowercased party name — but `parties.name` has no UNIQUE
constraint, so on a name collision the row silently booked to whichever party
overwrote the map entry (highest id), with `include=1` and no reason. Every
*other* bad input in the parser excluded the row with a visible reason; only
the ambiguous case failed silent, and the review grid would show a
correct-looking resolved name. Caught by the pre-commit code-review pass —
tests only covered unique fixtures.

**Resolution:** collision detection when building the map (`"ambiguous"`
sentinel) → row excluded with "matches more than one party — rename one" +
pinned test with two same-name parties.

**Delta (rule):** resolving a human-entered NAME to a db id is only valid when
the name is provably unique in that lookup set. Any name/label→id map built
from a column without a UNIQUE constraint must detect collisions and turn
them into a visible per-row error — last-write-wins map building is a silent
misattribution bug, not a tiebreak. Applies to P5's Tally `ledger_mappings`
flow and any future name-matching import.

## 13. RVOS-002 P5 (2026-07-20): a balanced journal that was still wrong

**What happened:** the Tally importer collapses a many-legged voucher into one
staged row keyed on its single party ledger, letting `buildLegs` re-derive the
account side. The first cut only *recognized* the legs it knew about — tax
ledgers on a trade voucher, cash/bank on a settlement — and quietly ignored
every other leg while still staging the full party-leg gross. So a receipt of
₹10,000 that arrived as ₹9,000 bank + ₹1,000 TDS withheld staged as a clean
₹10,000 receipt: Bank debited for money that never landed, the TDS never
booked. Same shape for a discount or round-off on a sale, and for a fixed
asset bought on a Purchase voucher (booked to Purchases, i.e. capex expensed).
A sibling bug: a settlement whose non-party ledger mapped to neither Cash nor
Bank fell through to a `"cash"` default, moving money through an account the
voucher never touched.

Every one of these produced a *balanced* journal — the party leg and the
derived legs always summed to zero — and landed `include=1` with no reason, so
nothing in review or the trial balance could flag it. The unit tests missed it
because every fixture was a clean 2-leg settlement or a textbook
party+revenue+CGST+SGST sale. Caught by the pre-commit code-review pass.

**Resolution:** `MappedAccount` now carries the account `type`, and both
branches partition the legs and refuse the remainder — settlements require
exactly one cash/bank leg (no default), trade vouchers consume tax legs plus
non-tax legs whose type matches the voucher's side (income for sale/credit
note, expense for purchase/debit note) and refuse anything left over. Multiple
same-type revenue legs still import, since summing those into Sales is
faithful. Six pinned tests, including a discount on a *zero-tax* sale so GST
reconciliation can't be what catches it.

**Delta (rule):** when collapsing a many-legged source record into a
lower-arity internal shape, every source leg must be explicitly consumed or
explicitly refused. A partition that only matches the legs it recognizes
discards the rest silently — and because the collapsed shape is re-derived
from a control total, the result still balances. **Balance is not proof of
faithfulness:** assert that the parts were all accounted for, not just that
the sum came out right. Applies to any future importer (bank statements,
26AS, e-invoice JSON) that folds N source lines into one internal entry.

## 14. RVOS-002 P6 (2026-07-20): a pool that let out what it never let in

**What happened:** IT-Act depreciation pools every asset of a rate into one
*block*. Cost enters the block only when an asset is PUT TO USE — an asset
bought but never commissioned contributes nothing. The first cut of
`stepYear` honoured that on the way in, but on the way out it gated disposals
on `disposed_date` alone. So selling an asset that had never been put to use
took its proceeds *out* of a block its cost had never gone *into*, shrinking
the block and cutting the depreciation claimed on every other asset in it.
Nothing looked wrong: the schedule balanced, the journal balanced, the trial
balance stayed at zero, and the only symptom was a client under-claiming
depreciation on a tax return. Caught by the pre-commit code-review pass.

The same review found a matching hole in the UI path — `disposeAsset` checked
only that a disposal wasn't dated before the *purchase*, so the office could
dispose of an unused asset, or back-date a disposal before the in-use date,
and get a wrong number with no error.

**Resolution:** the disposal branch now requires `put_to_use_date` set and on
or before the year end; `disposeAsset` refuses an asset that never entered a
block ("record the sale as a manual voucher instead") and refuses a disposal
before the in-use date; `fixed_assets` grew paired CHECKs so the timeline
holds against direct SQL too. The engine test deliberately runs against a
table recreated WITHOUT those CHECKs — `CREATE TABLE IF NOT EXISTS` never
revisits an existing table, so every db built before this phase still has the
old shape and the engine has to hold the line by itself.

**Delta (rule):** a pooled aggregate — a depreciation block, a batch, any
control total — must gate ENTRY and EXIT on the SAME condition. If a member's
value enters only when some predicate holds, its value may leave only when
that same predicate holds. An asymmetry between the add-condition and the
remove-condition doesn't corrupt the offending member, it corrupts the pool,
and therefore silently misstates every *other* member. When writing the exit
path, re-read the entry path and copy its predicate rather than restating it.

**Delta (rule, second):** when a page shows a DERIVED figure next to a POSTED
one — a recomputed schedule beside the journal that booked it — it must
reconcile the two and say so when they differ. Posting depreciation and then
adding an asset left the page showing a freshly recomputed total while the
books held the old one, with nothing flagging the divergence; on post-only
books that gap is only closable by a manual reversing entry, so it has to be
visible the moment it opens. Applies to P7's computation and P10's CA pack,
both of which display derived tax figures against posted books.

## 15. RVOS-002 P7 (2026-07-20): a relief priced against the wrong baseline

**What happened:** surcharge marginal relief exists so that crossing an income
threshold never costs more in tax than the income earned above it. The relief
is computed against a reference point — the liability *at* the threshold — and
the first cut priced that reference as bare slab tax while the actual
liability it was capping included surcharge. At the FIRST threshold the two
agree (no surcharge applies below ₹50L), so every hand-checked example passed.
At every threshold after that they diverge by the surcharge already running
just underneath, relief was over-granted by that whole amount, and **total tax
fell as income rose** — an old-regime individual going from ₹1,00,00,000 to
₹1,00,00,100 saw tax drop by ₹2,92,400, and a company crossing ₹10 crore
dropped ₹18,19,900. Caught by the pre-commit code-review pass, which executed
the boundaries rather than reading them.

**Resolution:** `surchargeWithRelief` now computes the reference recursively —
the liability at a threshold is itself relief-adjusted, one tier down — and
takes a `taxBeforeSurcharge` callback so the reference and the actual are
priced by the *same function* (post-rebate slabs for an individual, flat rate
for a firm or company). Plus a property test asserting tax never falls as
income rises, across all five pricing paths × every threshold × five deltas.

**Delta (rule):** when a cap, floor, relief or discount is computed relative to
a REFERENCE POINT, the reference must be priced with the identical function
that prices the thing being capped. A reference computed "the simple way"
silently diverges wherever the real calculation has picked up a term the
simple one lacks — and it will agree at the first boundary you test, which is
exactly why it survives review by example. Test the PROPERTY the rule exists
to guarantee (here: monotonicity — more income never means less tax), not a
handful of worked numbers. A property test over every boundary would have
caught this on the first run; nine pinned examples did not.

**Delta (rule, second):** metadata that qualifies a number — "these rates are
unconfirmed", "provisional", "as-of" — must be attached to EVERY rendering
path, and the format most likely to be consumed downstream is the one most
likely to be forgotten. The provisional-rates caveat reached the page and the
JSON export but not the CSV, which is precisely the artefact that gets pasted
into a filing workpaper. When adding a qualifier, enumerate the outputs and
check each one; a qualifier that travels with only some renderings is worse
than none, because the ones missing it look authoritative.

**Delta (rule, third):** a fix written to clear a review finding is new code
and earns the same scrutiny as the original — the P7 review's only WARN was
"`partnerRemunerationCeiling` is implemented but never called". Wiring it in
looked like housekeeping, but choosing what to compute it ON is a substantive
decision, and the basis chosen (book profit WITH depreciation added back) was
wrong: it overstated a firm's ceiling by the entire depreciation charge, and
was then rendered as filing guidance. The accompanying test only exercised
the zero-depreciation case, so it passed. The re-review caught it.

Two things follow. First, when a finding is closed by *adding* behaviour
rather than removing it, re-read the fix as if it arrived unreviewed, and
write the test for the case that makes the new code's decision visible — here,
non-zero depreciation. Second, prefer removing dead code to inventing a use
for it: "make the unused function used" invites a guess about semantics that
nobody asked for. If it is genuinely needed, the requirement will state what
it should be computed on.

## 16. RVOS-002 P8 (2026-07-20): the review came back clean on the money — the warns were all about the audit trail

**What happened:** the first phase of this build whose pre-commit review found
ZERO blocking money defects — evidence the accumulated rules (#10–#15) are
compounding: entry/exit predicates matched, every rendering carried the
unverified-rates caveat, the reference points were priced consistently, and
the atomicity test was written before the UI. What the review did find was
three WARNs, all the same species: **the audit trail claiming something the
transaction didn't do.** A rate override stored the section's default
`rate_bp` rather than the effective rate actually deducted; `tds_challans`
allowed a "deposited" row with no journal behind it while its sibling table
enforced the opposite; and one challan could silently mix salary and
non-salary deductions, making the 26Q/24Q undeposited figures irreconcilable
from the challan rows.

**Resolution:** effective rate stored on override (section bp kept when they
coincide); `journal_id NOT NULL` on challans, with the empty live table
deliberately recreated (EVOLUTION #14's CREATE-TABLE-IF-NOT-EXISTS trap);
challans are per-form (26Q or 24Q), enforced in the pending query and named in
the memo. Each fix pinned by a test targeting the case that exposes it.
The re-review then applied #15's own rule back at the per-form fix: making
challans per-form means a quarter can hold two, and rows that differ must be
DISTINGUISHABLE — so `tds_challans` gained a `form` column (NOT NULL CHECK),
written by the action and rendered on the page, live table recreated again.

**Delta (rule):** metadata columns that DESCRIBE a transaction (a rate, a
form, a link to the journal) are part of the transaction's truth, not
decoration — they must be derived from what actually happened, constrained
like their siblings, and partitioned the way the downstream reconciliation
partitions. "Not currently rendered anywhere" is not a defence: an audit
trail exists precisely for the reader who arrives later, and a wrong
`rate_bp` today is a wrong answer in next year's assessment query. When two
sibling tables share an invariant ("no claim without a journal"), enforce it
on both the day the second table is born — asymmetry between siblings is the
same bug as EVOLUTION #14's entry/exit asymmetry, one level up.

## 17. RVOS-002 P9 (2026-07-20): an allowlist built from a superset

**What happened:** the compliance board hides GST rows until a GSTIN is on
file and TDS rows until a TAN is set or a deduction exists — but the
`markCompliance` server action validated an incoming (rule_code, period)
against `dueItems(fy, { gst: true, tds: true })`: the full universe of rules,
both regimes hardcoded ON. The code even carried a comment defending it
("a mark on a hidden regime is harmless"). The zero-context review read it
the other way, correctly: a direct action call could mark a GSTR-1 "done"
for a business the board never shows GST to, and the phantom mark surfaces
pre-completed the day the GSTIN is filled in. The validation existed BECAUSE
of EVOLUTION #11 — and still re-opened the exact bypass it was written to
close, because the allowlist was derived from a different function than the
one that renders the form.

**Resolution:** the action now fetches the settings row and validates against
`generateItems(db, fy, settings, todayIso())` — the same engine call, same
regime switches, same db state that produced the board the user clicked.
That is only sound if board MEMBERSHIP never depends on `today` (statuses
may, items may not), so a test pins the item set identical across distant
todays. The reviewer's warn (blanket unverified banner) was fixed by gating
it on `items.some(i => !i.verified)`.

**The fix then failed its own re-review — on a different axis.** Applying
#15's rule (a review fix is new code), an adversarial 3-lens verify pass on
the fixed diff found the SAME bug shape surviving through the `fy`
parameter: the action format-checked fy (`fyStart`) while the page clamps
it to `fyList(db)` — so `fy="2035-36", advance-tax, done` passed the
engine-membership check (the engine rightly generates items for any
well-formed FY) and pre-marked a board no screen can reach, reproduced
live. The allowlist was again a superset, this time because ONE input to
the shared function was caller-supplied instead of render-derived. Fixed:
marking requires `fyList(db).includes(fy)` — the page's own set. The same
pass also caught the opposite failure on `clear`: gating a DELETE as
tightly as the INSERT traps a wrong mark whose regime later switched off
(invisible, uncorrectable, resurfacing as "done" when the regime returns).
Clear now requires only that the mark EXISTS — destroying your own metadata
can pre-mark nothing.

**Delta (rule):** a server-side allowlist must be derived by the SAME
function, with the SAME inputs, that rendered the user's choices — settings,
db state, all of it. A superset ("accept everything any configuration could
show") feels safe and is the bug: it validates against a world the user
isn't in. Check EVERY axis the form filters, including the ones that arrive
as the validator's own arguments — calling the right function with a
caller-supplied input is still a superset. Guards are directional:
creation/assertion validates against the rendered world; deletion of the
user's own metadata validates against existence, or the guard traps data it
can no longer see. Corollaries: when a validation calls a generator with an
uncontrolled input the generator doesn't strictly need (here: the clock),
pin with a test that the input cannot change the generated SET; and when a
guard carries a comment arguing why looseness is fine, treat the comment as
a review flag — the argument for the exception is usually the defect's own
description.

## 18. RVOS-002 P10 (2026-07-20): the annexure that re-hid what RVOS-001 exposed

**What happened:** the CA pack's debtors/creditors annexure was first composed
as "each party's own-ledger closing at FY end" — plausible, clean, and wrong.
The smoke leg written alongside it asserted the annexure ties to the Balance
Sheet's control accounts, and failed immediately: creditors ₹5,900 vs AP
control ₹9,800. The missing ₹3,900 was Sharma's payable — a CUSTOMER's
balance on the AP ledger, i.e. exactly the cross-ledger class RVOS-001's
ship gate forced party statements to expose. The lesson had been learned for
the statement page and silently un-learned in the next view composed over
the same data. A rendered pack with the ₹3,900 missing looked perfectly
fine; only the reconciliation assert could see it.

**Resolution:** `partyStatement` gained an optional inclusive `asOf` that
dates BOTH its ledgers (named params, omitted = byte-identical to before,
pinned by test); the annexure lists both sides of every party — own-ledger
closing on its own side, cross-ledger balance tagged on the side it actually
sits — and a critical banner fires when the totals still fail to tie
(control postings without a party). The zero-context review then returned
zero blockers; its three cosmetic warns (pack/page row-set parity in the tax
block, missing presumptive tag, dead print rule) were fixed and re-verified.

**Delta (rule):** when composing a NEW view over posted data, write its
reconciliation-to-control assert FIRST, before trusting any rendering — a
summary can look complete while omitting a whole class of rows, and only
the tie-out sees that. If a component of the summary cannot be dated to the
same basis as the rest (cross-ledger had no as-at), extend the source
function rather than approximate with a different date basis. And treat
every past lesson as attached to the DATA SHAPE, not the page it was
learned on: any new view over party balances re-inherits the cross-ledger
lesson, any new importer re-inherits "explicitly consume or refuse every
leg" (#13), any new allowlist re-inherits #17.

## 19. RVOS-002 rates verification (2026-07-21): the flip protocol, and what it caught

**What happened:** every statutory figure had shipped `verified: false` from
secondary sources, with banners on every surface — by design. The
verification pass (5 research agents fetching primary texts — Finance Act
2026 gazette, Income-tax Act 2025 gazette, Income-tax Rules 2026, Budget
Memorandum, GST portal — then an independent adversarial re-check of all 31
claims, each required to state its FY-vs-AY basis) confirmed the income-tax
table wholesale but caught real drift the tests could never see: two TDS
thresholds were stale (194J ₹30k → ₹50k/yr; 194I's ₹2.4L/yr aggregate no
longer exists — it is ₹50k per month-or-part), the filings themselves are
renumbered from FY 2026-27 (Form 140/138 replace 26Q/24Q, new numeric
section codes — Rules 2026), a NEW ITR tier exists (31 Aug for
business/professional non-audit, s.263(1)(c) as amended), presumptive
assessees owe ONE advance-tax instalment (s.408(2)) not four, and the
long-disputed rebate section number resolved to s.156 (not 157).

**Resolution:** a verified `2026-27` table with the gazette citations in
`source`; both thresholds corrected and pinned by tests; TdsSection grew a
`source` field; compliance rules flipped with per-rule authorities; ITR due
became entity- and year-aware; presumptive advance tax collapsed on the
board and in the computation; every "unconfirmed" banner became conditional
on the flags it reports; 26Q/24Q labels kept as familiar names with the new
filing identity displayed alongside. Deliberate conservatism, documented:
2025-26 stays unverified (a 1961-Act year no one checked against that Act);
a partnership's 31-Aug entitlement is unpinned, so its board shows the
earlier 31 Jul.

**Delta (rule):** statutory DATA is code that goes stale without failing a
single test — it needs its own verification protocol, now standing: fetch
the primary text (gazette, not a chart), state the FY/AY basis explicitly
for every figure, adversarially re-check each claim independently, put the
citation IN the data (`source` beside `verified`), and pin the corrected
values with tests so a silent revert fails loudly. Two corollaries: banners
must be driven by the flags they report (an unconditional caveat becomes a
lie the day the flag flips); and where an assessee's class is unpinned, a
deadline tracker's conservatism must be directional — always the EARLIER
date, never the later one.

## 20. RVOS-003 P2 (2026-07-21): never pattern-match a string a browser will PARSE

**What happened:** the post-login `next` target was sanitised with a string
test — reject anything not starting with `/`, and anything starting with `//`.
It reads as airtight and is not. The WHATWG URL parser normalises a leading
BACKSLASH to a slash, so `/\evil.com` starts with `/`, does not start with
`//`, passes both checks, and resolves to `http://evil.com/`. Confirmed live:
`new URL("/\\evil.com", "http://localhost:3322").href === "http://evil.com/"`.

Worse than a generic open redirect because `/login` is public: the payload
arrives on a link to our OWN real login page and fires AFTER the victim
authenticates with genuine credentials, so the browser is signed in when it
lands on the attacker's origin. Caught by the zero-context review of the branch
diff, not by the author, and not by any of the 30 tests written alongside it.

**Resolution:** parse instead of match — resolve the candidate against a
reserved sentinel origin (`http://sentinel.invalid`, RFC 2606) and require the
result not to have left it, returning only `pathname + search`. Pinned by tests
covering both backslash forms, protocol-relative, absolute, `javascript:`,
non-string input and hash stripping. `safeNextPath` had to move from
`auth-actions.ts` into `auth.ts` because a `"use server"` module may only
export async functions — anything in an actions file that needs a unit test has
to move out of it.

**Delta (rule):** when a value will later be handed to a PARSER, validate it
with that parser, not with string predicates. The parser's normalisation rules
(backslash→slash, percent-decoding, unicode case folding, whitespace
stripping) ARE the attack surface, and every one of them is invisible to
`startsWith`. Corollary for review: a hand-rolled sanitiser for a URL, path,
host or filename is a standing blocker candidate — check what parses it
downstream and use that.

## 21. RVOS-003 P1 (2026-07-21): a primary source can serve a STALE VERSION at a live URL

**What happened:** EVOLUTION #19 established "fetch the primary text, not a
chart." That rule proved necessary but not sufficient. `incometaxindia.gov.in`
hosts multiple VERSIONS of the same section at near-identical slugs, and the
obsolete ones rank HIGHER in generic search: a research agent cited
`/w/section-211-33` (the pre-1988 three-instalment scheme) and
`/w/section-234c-26` (pre-1994: 20%/50% thresholds, 1.5% rate) before catching
itself on a second pass. The bogus "1.5% s.234C" figure came from a genuine
government URL. Current slugs are `/w/section-211-64` and `/w/section-234c-34`.

**Resolution:** every retrieved section was re-fetched at a pinned version slug
and cross-checked against a second host (India Code). Both slugs recorded in
`RVOS-003-P1-FINDINGS.md` so the next pass does not re-discover the trap.

**Delta (rule):** "primary source" is a claim about the DOCUMENT, not about the
URL. Pin the version identifier, cross-check every statutory figure against a
second independent host, and treat a search-engine-ranked government URL as
untrusted until its version is confirmed. Where a source cannot be version-
pinned, the figure stays `verified: false` — a stale primary source is more
dangerous than a secondary one, because it survives every check aimed at
secondary sources.

## 22. RVOS-003 (2026-07-21): a brief's own premises are not evidence

**What happened:** the RVOS-003 spec asserted two things as background fact
while framing the research: that Finance Act 2025 raised the s.194C TDS
thresholds, and that FA 2025 revised the s.40(b) partner-remuneration ceiling.
Both are wrong — 194C's ₹30,000/₹1,00,000 were unchanged (from 2010 and 2016),
and the 40(b) revision was Finance (No. 2) Act 2024. Because the premises sat
in the task framing rather than in a result, they were on track to be written
into `source` fields AS citations. The agents contradicted their own brief only
because each was instructed to cite primary text for every figure
independently.

**Resolution:** both corrected in `RVOS-003-P1-FINDINGS.md` and called out
explicitly as brief-originated errors so they are not reintroduced.

**Delta (rule):** context supplied to an agent is an assumption under test, not
a given — state it as "verify X" rather than "given X", and never let framing
prose reach an authority field. Corollary: an agent that contradicts its own
brief is doing the job. Prompts for verification work must say so out loud, or
the agreeable answer is the likely one.

## 23. RVOS-003 P3 (2026-07-21): a `.db` file is not the database — live ledger lost and recovered

**What happened:** the qa-runner was briefed to protect the live book by
recording `shasum -a 256 data/revenueos.db` before its run and restoring the
file to that hash afterwards. It did exactly that, reported a matching hash,
and deleted `revenueos.db-wal` / `-shm` believing they held only its own test
writes. They held the entire ledger.

`data/revenueos.db` had been a 4096-byte stub containing NO TABLES since
2026-07-16. SQLite's default auto-checkpoint fires at 1000 WAL pages (~4 MB);
a small book never reaches it, so every committed row — 6 documents, 9
journals, 27 journal lines, 2 parties — sat in the sidecar indefinitely. The
sha256 matched because the file it hashed was empty, and had been for five
days. The verification could not fail and could not detect the loss.

It surfaced only because P3's `verifyBackup` refused the first real backup with
"no such table: journals" — the check written to make backups trustworthy is
what found the missing ledger. Recovered in full from an 881 KB WAL left in a
previous session's job scratch directory, then checkpointed into the main file
and asserted back to its exact baseline (TB net zero).

**Resolution:** `configureConnection()` now runs `wal_checkpoint(TRUNCATE)` on
every connection open and sets `wal_autocheckpoint = 64` pages, so the main
file is a real book within one restart. Pinned by a test that deletes the
sidecars and requires the book to still read. `scripts/backup.ts` uses
SQLite's ONLINE BACKUP API, never a file copy.

**Delta (rule):** for any database with sidecar files, the unit of integrity is
the DATABASE, not the file that shares its name. Never hash, copy, move, rsync
or delete a `.db` without its `-wal`/`-shm`. And a verification whose passing
state is indistinguishable from the failure state is not a verification: assert
CONTENT — a row count, a trial balance — through a connection that reads the
whole database, never a byte-identity check on one file. The corollary bit
hardest here: the instruction was followed correctly and the agent reported
success, because the check I designed was incapable of failing.

## 24. RVOS-003 P1 (2026-07-21): "conservative" is only conservative when the direction is genuinely unknown

**What happened:** research established that Finance Act 2026 s.5 created a
31 August ITR due date for a non-audited business assessee, reaching FY
2025-26. It was single-sourced at that point, so I kept the app showing the
earlier 31 July and wrote the reasoning down as directional conservatism —
"an unproven LATER deadline is the dangerous direction to be wrong in", the
corollary from EVOLUTION #19. That reasoning was sound in #19, where an
assessee's class was genuinely unpinned.

Here it was not. An adversarial pass, instructed to refute, established all
four parts from the verbatim substituted statutory table in the signed Gazette:
that FA 2026 s.5 amends the **1961** Act (s.4 defines "the Income-tax Act", and
s.5 sits in Chapter III Part A, not the Part B that amends ITA 2025); that its
express 1 March 2026 date overrides the general commencement and so reaches
AY 2026-27; that the tier exists; and that Sl.3 says "ASSESSEE having income
from profits and gains of business or profession", which covers a non-audited
firm and — via Sl.3(ii) — its partners. The verifier's own words: the earlier
date "is not the conservative choice; it is simply wrong for a non-audited
business assessee, and defaulting to it would misstate the deadline by a
month."

**Resolution:** the tier is adopted, gated on the income test rather than
entity_type, and two RVOS-002 tests that encoded the old assumption were
updated with the reasoning in-comment.

**Delta (rule):** conservatism is a tie-breaker for genuine uncertainty, not a
substitute for finishing the verification. Before defaulting to the "safe"
value, ask whether the answer is actually unknown or merely unconfirmed by ME
so far — and if the latter, go and confirm it. A wrong-but-cautious figure is
still a wrong figure, and it is harder to dislodge because it feels virtuous.
Corollary for the calendar specifically: a deadline shown a month early erodes
trust in every other date on the board.

## 25. RVOS-003 P1 (2026-07-21): verification metadata must live at the granularity verification actually happens

**What happened:** `TaxYearRates.verified` was ONE boolean covering ~15 field
groups — slabs, rebate, surcharge, cess, firm, company, s.40(b), advance tax,
presumptive. The adversarial pass cleared eight of those for FY 2025-26 from
gazette text and explicitly REFUSED the ninth (the s.44AD/44ADA/44AE
deemed-profit percentages, which rest on search snippets).

That left no honest value for the boolean. Setting it true would claim
verification nobody performed; leaving it false warned on eight groups that
ARE confirmed, on the year the office is actually filing — and a banner shown
over correct figures is how banners stop being read. The same shape existed in
`compliance.ts` (one flag per rule, one citation for every year) and in
`tds.ts` (ITA 2025 cited on an FY 2025-26 screen).

**Resolution:** verification is recorded per GROUP per YEAR, with the citation
beside it; `caveatForGroups(year, groups)` warns about only what a caller
actually read, and `buildComputation` declares the groups its branch used. An
FY 2025-26 book-profit computation now renders caveat-free. A finding fell out
of it: FY 2026-27 had been marked fully verified while nobody had ever checked
its presumptive percentages either, so both years now flag them.

**Delta (rule):** a verification flag must be as granular as the verification
that produced it. When one boolean spans work done by different people, at
different times, to different standards, every possible value of it is a lie —
and the pressure will always be to set it to the convenient one. Corollary: a
caveat must name what it doubts and be scoped to what the caller relied on,
or it becomes noise, and noise is indistinguishable from no warning at all.

## 26. RVOS-004 P3 (2026-08-04): a migration engine that nobody ever calls

**What happened:** P1 built `migrate()` and migration 001 — versioned,
backup-first, transaction-per-step, rollback-proven, thoroughly unit tested.
P2 built the Book handle on the assumption that `company_id` columns exist.
Nothing in `getDb()`/`open()` ever called `migrate()`. On a real running
instance — dev, the office machine, anywhere — the `companies` table would
never be created, because nothing had ever run the migration outside a test's
own hand-built `:memory:` database. The entire multi-tenancy feature would
have been dead on arrival the first time anyone actually started the app,
and none of P1 or P2's (excellent) test coverage could have caught it, because
none of it goes through `getDb()`.

**Resolution:** `open()` now calls `migrate()` on every boot
(`migrateInProcess` in db.ts). This is safe without a pre-migration backup
because `migrate()` is already transactionally self-protecting — each step
commits or rolls back on its own, re-proving the books balance after every
step. It is NOT the backed-up path the spec calls for on a real office
database: `createBackup` is genuinely async (SQLite's online backup API), and
`getDb()` is a synchronous singleton called from many places that cannot
await it — restructuring that was out of scope here. So the deliberate,
once-per-upgrade cutover is a new script, `npm run migrate`
(scripts/migrate.ts): it awaits a real verified backup FIRST, then calls the
same `migrate()` with a closure that simply reports that backup's already-known
path. Because migrations are idempotent, running that script before the app's
first post-upgrade boot makes the in-process call a no-op, not a race — order
of operations matters here, not exclusivity.

**Delta (rule):** a migration engine's own test suite proves the mechanism
works; it does not prove the mechanism is REACHABLE from the code path a real
user's server process actually takes. When a piece of infrastructure is
introduced in one phase and consumed in a later one, the phase that
introduces it must also wire it into the real boot path immediately — even if
nothing yet needs the data it produces — or the gap sits invisible until the
first live boot, well past the point where "it's still early, no real users
yet" is true. Corollary, found while fixing this: a synchronous singleton
(`getDb()`) and a genuinely async prerequisite (a verified backup) cannot be
reconciled by making the singleton wait; they are reconciled by doing the
async part BEFORE the singleton's synchronous contract is invoked, and
handing the sync side an already-satisfied promise (literally: a path that is
already known good) rather than a promise it would need to await.

**Second delta (smaller, same session):** the tenancy ratchet's offender
check (`test/tenancy-ratchet.test.ts`) matches scoped-table names against the
RAW FILE TEXT, not just SQL strings — deliberately, per its own docstring, to
avoid false negatives. It has a real false-positive cost: `src/lib/companies.ts`
tripped it purely because a docstring said "chart of accounts" in English
prose, not because it queried the `accounts` table. Exempted with a comment
explaining exactly why, rather than rewording working documentation to dodge
a test. A ratchet built to over-trigger should be treated that way at review
time — the fix is an explicit, reasoned exemption, not silence or a rewrite
of prose that was correct.


## 27. RVOS-004 P4 (2026-08-06): a smoke-test script drifted from a schema migration and nobody noticed until it ran

**What happened:** P1's migration rebuilt `ledger_mappings` with a
company-scoped uniqueness constraint (`UNIQUE(company_id, ledger_name)`,
replacing plain `UNIQUE(ledger_name)`). `scripts/smoke.ts` has its own
hand-rolled `INSERT INTO ledger_mappings ... ON CONFLICT(ledger_name) ...`
for the Tally-import step, written before P1 and never updated. It didn't
fail at P1, P2, or P3 time because nothing re-ran that exact code path in a
way that exercised the ON CONFLICT clause against the new schema until this
phase — it surfaced as `SQLITE_CONSTRAINT_CHECK`-adjacent
("ON CONFLICT clause does not match any PRIMARY KEY or UNIQUE constraint")
the first time `npm run smoke` was run end-to-end after P4's changes landed.
The static tenancy-ratchet guard (`test/tenancy-ratchet.test.ts`) could not
have caught this either way: it only walks `src/lib/`, not `scripts/`, and
this wasn't a missing-`company_id` bug — the SQL text had gone stale, not
unscoped.

**Resolution:** Updated `scripts/smoke.ts`'s insert to
`INSERT INTO ledger_mappings (company_id, ...)` with `ON CONFLICT(company_id,
ledger_name)`, matching the live schema, and scoped its paired `SELECT` the
same way. Also added `test/import-isolation.test.ts` (the explicit pinning
test the P4 spec calls for): two companies, deliberately distinguishable
data, both import paths (`stageExcelImport`, `finalizeTallyImport`) run
against one company's `Book`, asserting the other company's `documents`,
`staged_rows`, and `ledger_mappings` never move — including that a Book
cannot read a sibling company's row even by exact id/name.

**Delta (rule):** a schema migration's blast radius includes every raw SQL
string in the repo that touches the changed table, not just the files a
static analysis tool is scoped to walk. `scripts/` (smoke, backup, migrate,
restore) sit outside `src/lib/`'s guard rails by construction — they're
allowed direct `db.prepare` access because they legitimately need it — which
means they are also invisible to any tool built to catch scoping drift there.
Corollary: "the ship gate ran green last phase" is not evidence a script is
still correct this phase if the schema underneath it changed; a smoke script
is only proof of currentness the moment it's run, and phases that alter
schema should grep for every raw reference to the changed table/column
(`grep -rn "table_name" --include=*.ts`, not just `src/lib/`) as a matter of
course, not rely on a scoped static guard to surface it.

## 28. RVOS-004 P5 (2026-08-06): the spec's own text was stale about a phase that already shipped

**What happened:** `RVOS-004-SPEC.md`'s P5 bullet says "the CA pack, exports
and every report already run per company via P2" — written when the spec was
drafted, before P1–P4 actually shipped and settled on a narrower per-phase
scope than originally planned. `grep -c company_id src/lib/reports.ts`
returns 0: `reports.ts`, the CA pack (`src/app/pack/page.tsx`), and
`/api/export/[report]/route.ts` are entirely unscoped, still reading
`getDb()` directly with no company filter anywhere. This HANDOFF's own P6
section had already correctly flagged this gap after P3 — the SPEC document,
not the HANDOFF, is what was stale. Had the SPEC bullet been trusted at face
value while building P5's per-company export, the natural move would have
been to layer the new export on top of the CA pack / reports functions,
silently inheriting their missing company filter and shipping a "per-company
export" that actually always returned company 1's data regardless of which
company was asked for — the exact leakage class P4 and P5 both exist to rule
out, reintroduced by trusting a planning document instead of the code.

**Resolution:** Verified the claim by grep before building on it, found it
false, and built `exportCompany` (backup.ts) as a raw-data export that reads
`SCOPED_TABLES` directly by `company_id`, independent of `reports.ts`/
`pack/page.tsx`/the export route. It does not depend on their porting state
at all, so it is correct today AND remains correct once P6 ports those files
— nothing to revisit. The actual porting of `reports.ts`/`pack/page.tsx`/
`/api/export/[report]` stays exactly P6's job, exactly as HANDOFF.md already
said.

**Delta (rule):** A spec/ticket document is a snapshot of intent at the
moment it was written; the phases it describes can (and, here, did) land
with different scope than assumed by a LATER bullet in the same document.
"X already happened" inside a spec is a claim about the codebase, not a fact
about it — verify it the same way you'd verify any other claim about code
you didn't just write (grep, read the function, run the test), especially
before using it as a foundation for new work. A living HANDOFF that gets
corrected phase-by-phase is a more current source of truth than the static
spec it was generated from; when the two disagree, that disagreement is
itself a signal worth surfacing (as here) rather than silently trusting
whichever one was read first.

## 29. RVOS-004 P6 (2026-08-06): resuming into someone else's uncommitted work, with a live migration in it

**What happened:** A new session resumed on `feat/rvos-004-multi-client` and
found 52 modified files in the working tree — no commit, no HANDOFF entry,
no EVOLUTION entry. The diff was, in substance, all of P6: the tenancy
ratchet ported from 28 files to 0, and the ~14-file `settings`-singleton gap
closed via a real schema migration (003, `DROP TABLE settings`) that
`migrate()` runs automatically on every boot. Nothing recorded whether this
work had been verified, and — separately — there is a live `next dev`
process on :3322 running against the real `data/revenueos.db` (documented in
this same HANDOFF's GOTCHAS as Pranav's own session). An automatic
`DROP TABLE` landing uncommitted, undocumented, next to a live process
pointed at production-shaped data is exactly the shape of thing that gets
trusted and either lost (if reverted without checking) or run for real
before it was rehearsed (if committed and later booted against that file
without the P6 ship gate's own stated precondition — a rehearsed migration
on a copy, with a verified restore — having happened).

**Resolution:** Before doing anything else, verified independently rather
than trusting the diff's existence as proof it was already good:
`tsc --noEmit`, `npm test` (374/374), `eslint`, `npm run build` — all clean.
Then, specifically because of the DROP-TABLE migration, checked whether it
had already run against the real db — via a read-only `sqlite3` CLI query
(`SELECT name FROM sqlite_master ...`, `.tables`), deliberately NOT through
the app's own `getDb()`/`migrate()` path, since going through the app is
exactly the thing that would trigger the migration if it hadn't run yet.
Confirmed the real db still has `settings` and has no `companies` table at
all — it's untouched, still on the pre-RVOS-004 schema. Only then committed
(`8b0267f`) and updated HANDOFF/EVOLUTION to make the migration's
not-yet-rehearsed status explicit and loud, not just inferred from GOTCHAS.

**Delta (rule):** Finding a large uncommitted diff at the start of a session
is not evidence it's safe or correct — it's an unlabeled claim, same as a
stale spec bullet (see #28) or an unrun smoke test (see #27). Verify it the
same way: run the actual gates (types/tests/lint/build), and when the diff
includes anything that mutates state on its own on next run (a migration, a
destructive script, an auto-applied schema change), check what it would do
against the REAL target — read-only, and specifically NOT through the code
path that would trigger the mutation — before committing it anywhere near a
branch that could get booted against production-shaped data. "It's already
done" and "it's already safe" are different claims; the first being true
does not imply the second.

## 30. RVOS-004 P6 (2026-08-06): generalized a GOTCHA to a script it didn't apply to, without reading the script

**What happened:** The P6 HANDOFF entry (this same session, one commit
earlier) wrote "`npm run smoke` — blocked on GOTCHAS' live-server/real-db
conflict, needs an isolated `data/` dir first," extrapolated from an
existing GOTCHA about `next dev`/browser-drives sharing a cwd with the real
db. `scripts/smoke.ts` was never actually read before writing that. Reading
it before running it showed the script already `mkdtempSync`s a fresh OS
tmpdir and `chdir`s into it before ever importing `db.ts` — it was already
immune to the exact problem the note warned about, and makes no HTTP calls
either, so the :3322 dev server was never a factor. Running it directly
confirmed: green, and `data/revenueos.db` untouched (verified by mtime +
schema check same as #29).

**Delta (rule):** A caution inherited from a sibling concern (here: the
`next dev`/qa-runner cwd hazard) does not automatically transfer to a
different command just because both involve "the same db path" in the
abstract — each script's actual isolation mechanism has to be read, not
assumed from a nearby note. Writing caution into a HANDOFF is itself a claim
about the codebase (see #29's rule) and needs the same verification before
being asserted as fact — including, and maybe especially, cautions that feel
obviously prudent to carry over from one script to a neighboring one.

## 31. RVOS-004 P6 (2026-08-08): a concurrent session switched this repo's branch mid-task, and a commit almost landed on it

**What happened:** After building `test/isolation-suite.test.ts` and
verifying it (376 tests pass, including a deliberate-leak-then-revert
check), the commit was made — and landed on `feat/companies-page-redesign`,
not `feat/rvos-004-multi-client`. Checking `git reflog` showed the working
tree had been `git checkout`'d from `feat/rvos-004-multi-client` to
`feat/companies-page-redesign` between the previous HANDOFF commit
(`07e39fe`) and this one — not something this session did. `pgrep -fl
claude` found half a dozen other live Claude Code processes on the machine
(VS Code extension instances). The most likely explanation: another
concurrent session was pointed at this same repo and switched branches to
start an unrelated task, and this session's next commit — made without
re-checking `git branch --show-current` after resuming from a context
gap — landed wherever the working tree happened to be pointed, not where
the last-known state said it was.

**Resolution:** Before touching anything, confirmed no destructive race was
in progress (`git status` clean, no lock files, `git reflog` showed exactly
one checkout then one commit — nothing else had touched
`feat/companies-page-redesign`). Surfaced the situation to Pranav rather
than silently fixing it, since rewriting a branch another session might be
using is exactly the kind of action that needs a human in the loop even
when the mechanics are safe. With his go-ahead: cherry-picked the commit
onto `feat/rvos-004-multi-client` (clean apply, same tree), then reset
`feat/companies-page-redesign` back to `07e39fe` — provably lossless, since
the reflog confirmed that commit was the ONLY thing on that branch beyond
shared history.

**Delta (rule):** In an environment where multiple Claude Code sessions can
run concurrently against the same working directory (this machine, per
[[concurrent-session-check]] in the global memory — already flagged after a
2026-07-18 incident in a different repo), a session resuming after ANY
gap — a `/clear`, a long tool call, a context-compaction resume — must
re-verify `git branch --show-current` and `git status` before its next
commit, not trust the branch it last remembered being on. The failure mode
here was cheap to fix (nothing else was on the wrong branch yet), but the
same blind spot on a repo where a concurrent session HAD already committed
would turn "whoops, wrong branch" into "whose commit do I just cherry-picked
over," or worse, an accidental `git reset`/`checkout -- .` discarding
someone else's uncommitted work. Re-verifying branch identity is now a
standing check, not a one-time fix — see this HANDOFF's own GOTCHAS entry.

## 32. RVOS-004 P6 (2026-08-08): the migration-rehearsal ship gate found a real bug, by actually running it

**What happened:** P6's ship gate requires "migration rehearsed on a COPY
of the real office database, snapshot restore verified, BEFORE it's ever
run for real." Starting that rehearsal, step one was the office's own
precondition — `npm run backup` — run against the real (still
pre-migration) `data/revenueos.db`. It failed outright: `no such table:
companies`. P6's own earlier commit (`8b0267f`) had changed
`verifyBackup`'s sanity-check table list from `["journals", "journal_lines",
"accounts", "settings"]` to `["journals", "journal_lines", "accounts",
"companies"]` — correct for a database that has already been migrated, but
every real installation is on the OLD schema right up until someone runs
`npm run migrate`, and this office's actually is. The effect: `npm run
backup`, the exact command the migration ship gate itself instructs
running FIRST, was broken for every not-yet-migrated database, including
the real one sitting behind the live :3322 dev server.

**Resolution:** `verifyBackup` now checks whichever identity table the
schema actually has — `companies` if migration 001 has run, `settings` if
it hasn't, and fails only if NEITHER exists (a genuinely foreign/corrupt
file). Added a regression test (`test/backup.test.ts`) that builds a
fixture with `initSchema` + `seedCoreData` but deliberately WITHOUT calling
`migrate()`, asserting `verifyBackup` still passes it. Re-ran `npm run
backup` against the real db afterward — succeeded, 4 snapshots retained,
source db's mtime unchanged (confirmed via `ls -la` before/after, same as
the check in #29). 377 tests pass (was 376).

**Delta (rule):** A ship gate that says "rehearse before running for real"
is not satisfied by rehearsing against a database already shaped like the
END state — the whole value of a rehearsal is running it against what the
target ACTUALLY looks like right now, warts included. Here, "run the actual
precondition command against the actual real file" surfaced a regression in
under a minute that a rehearsal against a fixture already migrated to
`companies` would never have found, because that fixture would never
exercise the pre-migration code path at all. This is the same lesson as
#27 (a smoke script silently drifted from a schema change) and #29/#30
(verify a claim about the codebase before trusting it) wearing a different
coat: a migration's "ship gate" needs to be exercised against a
BEFORE-shaped database, not an idealized AFTER-shaped one, or it will
rubber-stamp exactly the class of bug it exists to catch.

## 33. RVOS-004 P6 (2026-08-08): ship gate closed — no failures on the final two passes

**What happened:** The last two ship-gate line items ran clean. The
zero-context code-reviewer pass over the FULL branch diff
(`master...feat/rvos-004-multi-client`, 81 files) found 0 blockers,
including its explicit tenancy-leakage pass — it independently verified
(not just accepted) that `book.ts`'s runtime guard and the ratchet test
share one code path, that `requireBook()` never caches a company across
calls, and that `test/isolation-suite.test.ts` isn't vacuous. The
qa-runner's live 2-company HTTP drive against a freshly refreshed
`~/revenueos-preview` (this branch's tip, wiped `data/`) found 0
cross-company leaks across every report kind, including a direct
per-record check (`/parties/<id>` 404s for the wrong company, not just a
filtered list) that no unit test in this repo currently performs.

**No fix needed — logged per the standing rule that a clean gate run gets
recorded too, not only the ones that found something** (see [[agentic-workflow-standard|the global instruction]]:
every build session ends with either a logged delta or an explicit "no
failures"). The two prior findings this same ship gate DID surface (#32:
`verifyBackup` broken on pre-migration databases; the branch-mixup
near-miss, #31) already prove the gate is doing real work — this entry is
the honest complement: verified doesn't mean re-litigated. The RVOS-004
ship gate — tests/smoke/lint/build, code-reviewer, qa-runner, and a
verified-restorable migration rehearsal — is now fully closed.

## 34. RVOS-004/005 (2026-08-08): rebasing a parallel branch onto a finished tenancy migration surfaces exactly the code the ratchet couldn't see

**What happened:** `feat/rvos-005-dashboard-ux` was cut from this branch's
P2a tip (before P3–P6 existed) and built a dashboard trend/census feature
against the then-single-tenant `reports.ts`. Rebasing it onto this branch's
now-fully-shipped tip conflicted, as expected, in `reports.ts` and
`page.tsx` — resolved by porting `receivablesTrend`/
`documentStatusBreakdown` onto the `Book` handle (the exact "PORT" item this
HANDOFF had been carrying since P6 landed, precisely because those two
functions postdate every ratchet scan that ever ran and could never be
caught by it). Full detail, plus the doc-conflict renumbering this rebase
also required, lives on `feat/rvos-005-dashboard-ux`'s OWN EVOLUTION.md
entries #34 and #35 (numbered independently on that branch's history — note
for whoever does the eventual merge: THIS branch's own entries stop at #33,
so #34 exists on both lines right now and needs the same renumber-at-merge
treatment #31 already documented for the #26 collision between these same
two branches).

**Delta (rule):** this is the second time in one build that two branches
diverging before a tenancy migration produced a numbering collision in
EVOLUTION.md at merge time (see #31's GOTCHAS note). Any branch cut before
a schema-shaping migration lands, and rebased onto it afterward, should
expect this — not as a surprise each time, but as a standing property of
working two branches off the same point in a fast-moving schema history.

## 35. RVOS-005 code review (2026-08-08): the isolation suite's own coverage lagged the port it was supposed to be proving

**What happened:** The zero-context code-reviewer pass over RVOS-005's own
diff flagged that `test/isolation-suite.test.ts`'s `snapshot()` function —
the ship gate's central proof that no report leaks across companies — had
never been updated to include `receivablesTrend`/`documentStatusBreakdown`,
even though those two functions had JUST been ported onto the `Book` handle
in this same session's rebase (#34). The SQL itself was correct (verified
independently, and would trip `book.ts`'s structural guard if it weren't),
but nothing in the automated suite actually EXERCISED that correctness for
these two functions — the isolation proof's own coverage had quietly
stopped growing at exactly the point new report functions stopped being
report-route exports.

Fixing it surfaced a second, deeper gap while fixing the first: adding the
two fields to `snapshot()` didn't actually prove anything, because neither
test company (A, B, or the empty control C) had ever posted a single
`documents` row in the whole fixture — only vouchers. `documentStatusBreakdown`
was `[]` for every company regardless of whether its scoping was correct or
broken, which would have made the "fix" pure theater: a field present in
the snapshot object, contributing zero actual assertions.

**Resolution:** Added `insertDocument()` and a distinguishing status per
company (A: `posted`, B: `extracted`) to the isolation fixture, then
verified the fix has real teeth rather than trusting the green run:
deliberately broke `documentStatusBreakdown`'s WHERE clause in a way that
keeps the literal substring `"company_id"` present in the SQL text (so
`book.ts`'s text-matching guard does NOT fire — the realistic "looks scoped,
isn't" case, not the easy "obviously missing" case caught by #29-style
mutation tests earlier this build). Confirmed the suite now catches it —
company C's empty control came back holding company A's document — then
reverted.

**Delta (rule):** A ship-gate test suite is itself code with its own
coverage, and coverage of a GENERIC gate ("every report function") silently
lags any new function added after the gate was last touched — exactly the
same shape of gap as #34's ratchet-can't-see-new-files finding, one layer
up. Adding a field to an isolation snapshot is not evidence the isolation
snapshot now proves anything about that field; the fixture has to actually
exercise the code path (real data, not vacuous emptiness) AND the assertion
has to be confirmed to fail on a realistic broken version — specifically
one that would survive whatever cheaper structural guard exists (here:
keeping the text-matched keyword present), since that is the actual bug
class a behavioral test earns its keep by catching. A code review that
merely confirms "the new code is correct" without asking "does the thing
that's supposed to CATCH new code actually see this new code" would have
missed both gaps here.

## 36. Companies page visual redesign (2026-08-08): no failures

**What happened:** Restyled the Companies page and the shared app shell
(sidebar, topbar, design tokens in `globals.css`) to a new "Ledger Blue"
scheme against a reference screenshot — dark navy glass sidebar widened to
310px, ice-blue content canvas, new accent/status colors, bumped card radii
and title weight. Zero routes, fields, server actions, or keyboard shortcuts
touched; only class names and CSS custom properties changed. Verified by:
full `npm test` (377/377 pass, unchanged from before the diff), `tsc
--noEmit` clean, `eslint` clean, and a real browser pass — minted a session
for the existing user directly via `createSession()` (no password touched,
session row deleted after) and screenshotted `/companies`, `/` (redirect-to-
companies gate still fires with no active company, confirming the guard
wasn't affected), and the collapsed/rail sidebar state via the real `⌃B`
shortcut, all with Playwright.

**No fix needed — logged per the standing rule that a clean session gets
recorded too** (see [[agentic-workflow-standard|the global instruction]]).
One thing worth naming for next time: `.side-user` had two dangling
selectors left in `globals.css`'s rail-collapse transition rules after the
sidebar's user-info block was dropped to match the reference — caught and
removed in the same pass, not left as dead CSS.

## 37. Companies redesign, legibility pass (2026-08-08): shipped two WCAG contrast failures on round 1, caught on request rather than by the build itself

**What happened:** The round-1 redesign (#36) picked `--ink-3: #7c93ac` (muted
body/meta text on the new ice-blue canvas) and `--sidebar-ink-3: #5b7290`
(sidebar section headers) by eye against the reference screenshot, without
computing contrast. Asked afterward to check legibility, a WCAG relative-
luminance calculation on every text/background pair in the new token set
found both fail AA for normal text: `ink-3` on `--page`/`--surface` measured
2.88:1 / 3.17:1 (needs 4.5:1) — this is the color used for the Companies
page's description paragraph, every card's metadata line, and the archived
list; `sidebar-ink-3` on the sidebar gradient measured 3.36–3.82:1, used for
the uppercase section headers ("1 · LEDGER ENTRY" etc.) and the "· ⌃B" hint.
Both would read as borderline-illegible light gray on a bright background
for anyone without excellent contrast vision — the opposite of "high-trust."

**Context that made this easy to miss:** the ORIGINAL pre-redesign tokens
had the same defect (`#86868b` ink-3 on the old `#f5f5f7` page measured only
3.33–3.62:1) — so this was not a regression introduced by the redesign, it
was a pre-existing gap the redesign inherited and, by moving to a lighter/
bluer palette, made slightly worse. Nothing in the ship path (tsc, eslint,
the 377-test suite) checks color contrast, so a purely-visual change can
fail an accessibility bar that no automated gate here watches for.

**Resolution:** Solved numerically for the lightest/darkest values in the
same hue family that still hit ≥4.5:1 against every background they're
actually used on (white cards AND the ice-blue page for `ink-3`; both
gradient stops for `sidebar-ink-3`), rather than eyeballing a fix:
`ink-3 → #5e7083` (5.10:1 white / 4.62:1 page), `sidebar-ink-3 → #7589a2`
(5.26:1 / 4.63:1). Verified the fix landed in the actual rendered DOM (not
just the CSS source) by reading `getComputedStyle(...).color` off the live
page in a real browser pass, not just re-running the ratio formula on the
source file.

**Delta (rule):** A visual/token-only change still needs a contrast check
before it ships, the same way a logic change needs a test — "matches the
reference screenshot" is not the same claim as "meets AA," and a reference
image can itself encode a contrast failure that's easy to eyeball past.
When picking or changing any `--ink-*`/muted-text token, compute WCAG ratio
against every background it is actually composited on (not just the most
common one) before treating the color as final, the same way `book.ts`'s
structural guard exists because "looks right" isn't a check.

## 38. RVOS-006 P0a: real bank accounts, caught starting the dev server against the live db mid-build

**What happened:** Retired the hardcoded `settle_account TEXT CHECK (IN
('cash','bank'))` enum — 58 call sites mapping to exactly two ledger codes —
in favour of a real `bank_accounts` table (migration 004), each account
owning its own chart-of-accounts ledger. `staged_rows.settle_account` becomes
`staged_rows.bank_account_id`. Ingestion paths (LLM photo, CSV, Tally XML)
still only ever produce a coarse cash-vs-bank HINT (`SettleHint`) — nothing
upstream can know WHICH of an office's several bank accounts a khata line
means — resolved to a real account at staging time by `defaultForHint`
(`src/lib/bank-accounts.ts`, new). Tally is the one exception: it names the
actual ledger a voucher settled through, so it resolves a REAL account
directly via `MappedAccount.bank_account_id` rather than a hint.
`seedAccountsForCompany` now also wraps a new company's seeded Cash/Bank in
`bank_accounts` rows, so onboarding after this migration doesn't leave a book
with nowhere for `defaultForHint` to resolve to. New `/settings/bank-accounts`
page for add/rename/set-default/archive (archive-only, and refused on the
last account of a kind — a future import would have nowhere to resolve). 391
tests pass (was 377), `tsc`/`eslint`/smoke/build all green.

Verified at two levels, stated separately because they prove different things:
*at test level*, `postDocument` posting three rows on three different
`bank_account_id`s each land on their OWN ledger code and not each other's,
and a row whose account was archived between staging and posting still posts
(deliberate — see `postDocument`'s `settleCodes` comment). *In a real browser*
against an isolated scratch instance: created a second bank account (ledger
1110 allocated in the bank range), renamed it, made it the default, archived
the now-non-default seeded "Bank", and confirmed the voucher form's "Settled
via" list then offered exactly the live accounts (`1110 …`, `1000 Cash`) with
the archived one correctly absent.

**Gap closed immediately after (same phase):** a contra between two real bank
accounts — the transfer the old enum made *unrepresentable*, since both ends
resolved to ledger 1100 and the voucher would have been refused as
same-account — now has two tests: one proving 1100 → 1110 moves two DIFFERENT
ledgers and leaves the trial-balance totals completely unchanged (an internal
transfer must not read as new income or a new liability, so "still balanced"
is too weak a claim), and one proving a `bank_account_id` from another company
is refused. Both were mutation-tested: collapsing the two contra legs onto one
account fails 3 tests, so the coverage is real rather than vacuous. Writing
the first of them also corrected my own wrong assumption — I initially
asserted the totals should GROW by the transfer amount, which would have
encoded a misunderstanding of what a contra is into the suite.

That browser pass also caught a defect no automated gate here could see: the
name cell's `<input className="w-full">` inside a flex row collapsed to **18px**
because a flex item's default `min-width` is `auto`, so the Save button won the
row. The account name was present in the DOM and completely unreadable on
screen. Fixed with `min-w-0 flex-1` + `shrink-0` on the button and a rebalanced
column set (measured after: 164px, and `scrollWidth === clientWidth`, so no
overflow either). A width assertion is the kind of thing only a rendered pass
catches — `tsc` and 391 passing tests had nothing to say about it.

**What went wrong, caught mid-build:** To do that real-instance verification
I started `DEMO_MODE=1 npm run dev` from `~/revenueos` — and `DEMO_MODE` only
short-circuits LLM extraction with a canned fixture; it does **not** change
`DATA_DIR`, which `db.ts` still resolves from `process.cwd()`. Every ordinary
boot calls `migrate()` in-process with no `opts.backup` (this is documented
and deliberate — see `migrateInProcess`'s comment: "what every ordinary app
boot does," transactionally safe on its own). So starting the dev server for
what I intended as a throwaway UI check ran migration 004 for real, against
`data/revenueos.db` — the actual production ledger — with no independently
verified backup taken FIRST, which is exactly the cutover discipline
`scripts/migrate.ts` exists to enforce and which this session skipped by
accident.

**Why it turned out fine, verified rather than assumed:** stopped the server
immediately on noticing; `PRAGMA integrity_check` → `ok`, `foreign_key_check`
→ empty, `journal_lines` net → 0 paise, and every table's row count intact
across both companies in that book. The migration engine's own design is why:
transactional, foreign-key-checked, and `assertBooksIntact` re-proven before
commit. Independently re-checked afterwards on the live file: `schema_version`
shows 004 applied once at 2026-08-10T11:46:41Z, all 48 staged rows carry a
non-NULL `bank_account_id` (0 nulls), and `bank_accounts` holds a defaulted
cash + bank pair for BOTH companies in that book. A snapshot dated ~2 minutes
after the migration exists at `data/backups/revenueos-20260810-114804`
(verified here: version 4, net 0 paise, `integrity_check ok`) — but that is a
post-migration snapshot, so the genuine pre-004 rollback point is the older
`revenueos-20260808-005733`. A verified backup taken BEFORE the DDL, which is
what `scripts/migrate.ts` exists to guarantee, is precisely what was missing.

**Delta (rule):** `DEMO_MODE=1` is NOT a sandbox flag — it only fakes the LLM
call. The only way to run this app against throwaway data is a `cwd` that
has no `data/` of its own (a genuinely separate directory), never the real
repo root, regardless of `DEMO_MODE`. Any future "let me just start the dev
server to check the UI" must first confirm `pwd` is NOT the real project root
— or better, must go through a fully isolated copy the way the eventual
browser check in this same session did (real `npm ci` install, `src` and
config files copied not symlinked — Turbopack's root-escape check rejects a
symlinked `src`/config even though a symlinked `node_modules` is fine, so a
scratch instance needs real files at the project root, symlink only
`node_modules`). Added to `[[agentic-workflow-standard]]`-equivalent personal
practice going forward: a `data/` directory existing at `cwd` is the actual
signal to check, not the env var.

## 39. RVOS-006 P0b: attribution, roles and an audit trail — no failures

**What happened:** Closed the second of the two defects Stage 0 exists for.
`journals` recorded WHEN an entry was posted and never WHO, and `auth_users`
had no role — so every person who could sign in could post to any client's
books, lock a year and change a client's tax identity, and afterwards nothing
recorded which of them had. For a firm with staff on shared client books that
is the control gap, not a missing convenience.

Migration 005 adds `journals.created_by`, `auth_users.role`
(owner/accountant/clerk/viewer, CHECK-constrained) and an `audit_log`.
`src/lib/roles.ts` holds the capability matrix as pure data; `dal.ts` — already
this app's real authorization boundary — is the only thing that enforces it.

**Three decisions worth keeping:**

1. **The actor rides on the `Book` handle**, not on each posting function's
   parameter list. `requireBook()` builds the handle from the session, which
   already knows who is asking, so every write underneath inherits attribution
   and no call site can forget to pass it. `null` stays a real value: a
   migration, a CLI script or a test genuinely has no signed-in user, and
   recording "unknown" is correct where inventing the only user's name would be
   fabricating an audit trail. Reports render NULL as absent, never as a name.

2. **`audit_log` is append-only via TRIGGERS**, not convention. UPDATE and
   DELETE both `RAISE(ABORT)`. A trail the application can quietly rewrite is
   not evidence of anything, and the app has no code path that edits history —
   now it cannot grow one by accident either. The log write happens INSIDE the
   posting transaction, so a rolled-back post leaves no row (tested) — a log
   entry for a change that did not happen is a lie, and a change with no entry
   is the gap the log exists to close.

3. **Existing users default to `owner`.** Before this migration nobody's
   authority WAS restricted, so demoting the office's existing logins would
   silently remove access they already rely on, and on a single-user install
   would lock them out of their own books. New users get a role explicitly.

**The capability that can remove itself:** `users.manage` is unique — an owner
demoting the last owner leaves an installation where nobody can ever add a
user or change a client's tax identity again, with no password-reset email and
no support channel, because this machine holds the books and nothing else
does. `setStaffRole` refuses it outright rather than warning in the UI.

**Delta (rule):** `requireBook()` defaults to `book.read` so display-only pages
needed no edit — but that default is exactly wrong for a server action, every
one of which mutates. A new ratchet in `test/route-guards.test.ts` asserts that
NO `requireBook()` inside `actions.ts` is called without a capability, so a
future action that forgets one fails a test instead of silently authorizing a
viewer to perform it. Same shape as the tenancy ratchet: make the omission
loud rather than trusting everyone to remember. All 24 existing actions were
assigned a capability cut by consequence (`entry.stage` for reversible
staging, `entry.post` for immutable journals, `accounts.manage`,
`company.manage`).

Verified: 412 tests pass (was 393), tsc/eslint/smoke/build green. The role
matrix and the audit guarantees were mutation-tested — granting `clerk` the
post capability fails 3 tests, and silently skipping the audit write fails 5 —
so the coverage is real rather than vacuous.

**Not done in this phase, deliberately:** there is no staff-management PAGE
yet. `src/lib/staff.ts` (`listStaff`, `createStaff`, `setStaffRole`, with the
lockout guard) is the mechanism and is tested, but assigning a role currently
means calling it from a script. Noted in HANDOFF rather than left implied-done.

## 40. RVOS-006 P0b UI: two stale string-matching guards, and a 500 that should have been a sentence

**What happened:** Built the staff page, the audit viewer, and the remaining
audit writes. Three things worth recording, all found by running it rather than
by reading it.

**1. The same stale-detector bug twice.** `test/route-guards.test.ts` proves
every page and every server action is guarded, by string-matching
`requireBook()` — with empty parens. P0b gave `requireBook` an optional
capability argument, so `requireBook("users.manage")` stopped matching and the
test reported two correctly-guarded pages as UNGUARDED. That is the dangerous
direction for a security test to fail in: believed, it sends someone to "fix"
pages that were already safe, and it trains people to dismiss the alarm. Both
detectors now match the CALL (`/require(?:Session|Book)\s*\(/`) rather than one
exact arity, and I mutation-tested the loosened version by deleting a real
guard to confirm it still fails. **Rule: a guard that string-matches source
must match the call, not a signature — signatures change, and the test must
fail only when the guarantee is actually gone.**

**2. A 500 is not a refusal.** `requireBook(capability)` throws, which is right
for a Server Action (silently redirecting a POST would look like success to the
caller) but wrong for a page: a clerk following a stale link to
`/settings/staff` got Next's generic "Application error" 500, which reads as a
broken app rather than as "this is not for you." Next's `forbidden()` is the
idiomatic fix but is gated behind the experimental `authInterrupts` flag, and
enabling an experimental flag in an accounting app to improve one settings page
is the wrong trade. The page now checks `userCan` itself and renders an
owners-only panel, loading no staff data unless the check passes — verified in
a browser that the refusal shows and the staff table is absent from the DOM.
The ACTIONS still enforce independently; the page branch is presentation.

**3. A duplicate username surfaced as `SqliteError: UNIQUE constraint failed`.**
Invisible while the only way to create a user was the one-time first-run form;
the moment staff can be added routinely, typing a taken name is an ordinary
mistake and must not look like a crash. `createStaff` now checks first and
throws a sentence. The UNIQUE constraint remains the actual guarantee — the
check is a better message in front of it, not a replacement (two simultaneous
requests still race, and the constraint still wins). Tested including the
case-insensitive path, which works because the column is `COLLATE NOCASE`.

Verified: 413 tests, tsc/eslint/smoke/build green, plus a two-login browser
pass (owner and clerk) proving enforcement from both sides.
