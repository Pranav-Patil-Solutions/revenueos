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
