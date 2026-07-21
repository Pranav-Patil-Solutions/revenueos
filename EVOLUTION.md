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

