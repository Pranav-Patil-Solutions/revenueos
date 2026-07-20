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
