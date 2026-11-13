# RVOS-006 — Books → ITR automation flow, and the path to a hosted app · Plan
# Owner: Pranav · Status: DRAFT for approval — nothing below is built yet
# Written 2026-11-13 against master @ dfdb0de (400 tests, tsc/lint/build/smoke green)

## 1. The rule that makes automation safe

Every stage is either a **machine stage** (deterministic, tested, re-runnable)
or a **human gate** (one person approves, their name and time are recorded).
AI may only *propose*; it never posts, never files. This is already how
capture → review → post works; the plan extends the same rule to the end.

The second rule: **every figure in a return must trace back to journal lines**,
and every stage refuses to run while the stage before it has open exceptions.
A flow that "mostly" reconciles is how a wrong return gets filed.

## 2. The flow, end to end

| # | Stage | Kind | Exists today | Gap |
|---|---|---|---|---|
| 1 | Client onboarding (entity type, PAN, GSTIN, FY, opening balances) | human | yes (`/companies`, DAY-ONE §4) | TAN, bank accounts, regime choice per FY |
| 2 | Capture: ledger photo, Excel/CSV, Tally XML | machine + review | yes | **bank statement import** (CSV/PDF); purchase-bill photo; multi-page |
| 3 | Classify to account + party + GST rate | AI proposes | partly (extraction, `ledger_mappings`) | learned rules per company ("this narration → this ledger"), so month 2 needs no review |
| 4 | Post to double-entry books | machine | yes (balanced by construction) | void/reverse journal instead of fix-forward only |
| 5 | **Bank reconciliation** | machine + exceptions | **no** | match bank lines to journals; unmatched = exception queue. This is the gate that proves the books are complete |
| 6 | Monthly GST: GSTR-1 / 3B | machine | summaries only | **GSTR-2B import + ITC match**; B2C/HSN/credit-note tables; portal-schema JSON |
| 7 | TDS: deduct, challan, 26Q/24Q | machine | register + summaries | return file in the official format; **26AS/AIS import to match TDS credit** |
| 8 | Month close (lock) | human gate | soft lock only | hard close with checklist: bank rec zero, GST matched, suspense zero |
| 9 | Year end: depreciation, closing stock, provisions, 43B/40A(3) disallowances | machine + human | depreciation yes; adjustments free-text | closing-stock entry; disallowance register driven by ledger flags, not typed by hand |
| 10 | Computation of income | machine | yes (`buildComputation`) | capital gains, house property, other sources, set-off/carry-forward of losses, Chapter VI-A (old regime), MAT/AMT |
| 11 | **Reconcile with AIS / 26AS / pre-fill** | machine + exceptions | **no** | turnover vs GST vs AIS three-way check; TDS claimed vs 26AS |
| 12 | **Pick the ITR form and map to its schedules** | machine | **no** | form selector (ITR-3/4/5/6) from entity + income; P&L and BS → schedule lines via an account→schedule map |
| 13 | **Generate ITR JSON in the department's schema, validate** | machine | **no** (only an internal computation JSON) | one generator per form per assessment year, validated against the published schema |
| 14 | CA review and sign-off | human gate | CA pack print | sign-off record; audit report data (3CD) if audit case |
| 15 | File + e-verify | human gate | no | phase 1: download JSON, upload on the portal by hand. Phase 2: bulk upload via an ERI |
| 16 | After filing: store acknowledgement, track intimation/refund/notices | machine | compliance board only | ITR-V storage, status column per client |

Stages 5, 11, 12, 13 are the four that do not exist at all. Nothing after
stage 5 can be trusted until stage 5 exists, so it is first.

## 3. Build order (each is its own RVOS build with a ship gate)

1. **RVOS-006 — Bank statement import + reconciliation.** Proves completeness.
2. **RVOS-007 — Exception queue + hard month close.** One screen listing
   everything blocking the next stage, per client. This is the automation's
   steering wheel; every later stage only adds exception types to it.
3. **RVOS-008 — GSTR-2B and 26AS/AIS import + matching.**
4. **RVOS-009 — Account→ITR-schedule map + form selector + ITR-4 JSON**
   (presumptive: smallest schema, most MSME clients). Then ITR-3, then ITR-5.
5. **RVOS-010 — Filing desk:** per-client status board for a CA firm
   (books closed → computed → reconciled → signed off → filed → verified).
6. **Later, needs a commercial decision:** direct filing. Only a registered
   e-Return Intermediary can submit returns for clients through the
   department's API; GST filing by API needs a GSP. Until then the app
   produces the validated file and a person uploads it. Do not build portal
   screen-scraping — it breaks without warning and puts client logins at risk.

## 4. Fix first (before any of the above)

- **Statutory verification per year.** FY 2026-27 is verified; FY 2025-26 is
  not. A return generator must refuse an unverified year, not just warn.
- **The real office database is still on the pre-RVOS-004 schema.** Run
  `npm run migrate` on a copy, verify a restore, then for real.
- **Windows install has never been run on Windows.**
- **Per-staff permissions.** Every staff member sees every client today.
  Acceptable for one office; a blocker for a filing desk with sign-off.

## 5. Converting to a hosted app like WerkOS — what to do now so it is cheap later

What already fits: the `Book` handle scopes every query by `company_id`
(that is row-level security, enforced in code), money is integer paise,
migrations are numbered, tests pin tenant isolation.

What blocks the move, in order of cost:

1. **SQLite calls are synchronous** (`better-sqlite3`) and spread through
   `src/lib`. Postgres is async. Put a thin async repository interface under
   `Book` *before* adding the stages above, so new code is written once.
2. **The AI transport is the local `claude` CLI.** A server cannot use a
   desktop login. Hide it behind one `extract()` interface now; the hosted
   build swaps in an API-billed implementation.
3. **Files on local disk** (`data/uploads`). Put them behind a storage
   interface (local folder now, object storage later).
4. **Tenancy has two levels in a hosted product:** CA firm → client company.
   Add `firm_id` above `company_id` when the repository layer goes in, and
   mirror the `Book` guard as database row-level-security policies.
5. **Client financial data in the cloud** needs India data residency,
   encryption at rest, access logs and a signed engagement with each firm.
   Decide the hosting region before the first hosted client, not after.

Recommended: keep the local build as the product for the first offices, do
items 1–3 as refactors with no behaviour change, and build stages 5–13 on top
of the new interfaces. The hosted version then becomes a second implementation
of three interfaces, not a rewrite.

## 6. Open questions for Pranav

1. Who files: the CA firm's staff (file-and-upload) or RevenueOS as a
   registered intermediary? This decides whether item 6 in §3 ever happens.
2. Which entity types first — proprietors on presumptive tax (ITR-4), or
   firms and companies (ITR-5/6, audit cases)?
3. Is the first hosted customer one CA firm with ~100 clients (the Santosh
   model), or individual SMEs?
