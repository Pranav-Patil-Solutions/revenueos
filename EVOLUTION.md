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
