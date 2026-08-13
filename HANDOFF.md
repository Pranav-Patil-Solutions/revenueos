# RVOS-006/007/008 HANDOFF — ACTIVE (resume here)

Task: turn RevenueOS from a correct ledger engine into a complete finance
department. Full 23-phase program in the approved plan at
`~/.claude/plans/bubbly-frolicking-prism.md` — read that first, this file is
just "where am I right now."

Repo `~/revenueos`. Port 3322 only. `DEMO_MODE=1` for tests/smoke — **but see
GOTCHAS, `DEMO_MODE` does NOT sandbox the database.** Never point a dev server
at `~/revenueos` as `cwd` for throwaway QA; use a genuinely separate directory.

Branch: `feat/rvos-006-finance-foundation`, off `feat/companies-visual-redesign`
@ `e4803d4`. `master` is further behind still (pre-multi-company) — not this
ticket's problem.

## STAGE 0 IS COMPLETE — P0a, P0b, P0c all committed

Stage 0 was the three foundations that rewrite columns every later phase writes
to. All three are in. Details of P0a (bank accounts) and P0b (attribution,
roles, audit log) are in EVOLUTION #38–#43; they are done and browser-verified.

## DONE (P0c — cost centres, migration 006)

**Committed.** 435/435 tests pass; tsc, eslint, `DEMO_MODE=1 npm run smoke` and
`npm run build` all green. Full reasoning in EVOLUTION **#44**.

- Migration 006: `cost_centres` (company-scoped, code UNIQUE per company,
  archive-only) + nullable `journal_lines.cost_centre_id` and
  `staged_rows.cost_centre_id`. `cost_centres` is in `SCOPED_TABLES`;
  `exportCompany` carries it (verified by an actual export round trip, ids
  preserved).
- `src/lib/cost-centres.ts` — list/get/create/rename/archive, `codeFromName`,
  `costCentreUsage`, and the two validators: `resolveCostCentre` (strict — for
  a choice made NOW, refuses archived) vs `assertOwnedCostCentre` (ownership
  only — for an id already saved on a staged row, so archiving a centre cannot
  strand an already-reviewed document). Same split posting.ts uses for bank
  accounts.
- **The rule that keeps it small: a cost centre lands on income and expense
  legs ONLY** (`stampCostCentre` in posting.ts). Tagging every leg would make
  any later sum-by-centre report double-count the same rupee. Mutation-tested —
  making the predicate always-true fails five tests.
- Threaded through BOTH posting paths: `postDocument` (from the staged row) and
  `postManualVoucher` / `postVoucherWithTds`. Receipt/payment/contra have no
  eligible leg, so the UI does not offer the field there rather than accepting a
  choice the engine discards.
- Actions gated on `accounts.manage`, each writing an audit row inside its own
  transaction. New `/settings/cost-centres` (add/rename/archive + a "Lines"
  count so archiving is a decision made with its consequence visible), a
  "Centre" column in the review grid (disabled on rows whose type has no P&L
  leg), and selects on the voucher form + TDS voucher.
- Smoke exercises it, posting AFTER the depreciation/computation legs have
  pinned their FY figures (an earlier expense would shift them — same reason
  the TDS leg posts in Q3).

### The real find: manual sales/purchases were un-postable since P0a

The browser pass caught a 500 on posting a **purchase** voucher: "Pick a cash
or bank account for this voucher." P0a's strict `formBankAccountId` demanded a
field the form only renders for receipt/payment, so **every manual sale,
purchase, credit note and debit note has been un-postable from the voucher form
since `1936ab7`** — invisible to every unit test (they pass an id straight to
`postManualVoucher`) and to smoke (its manual legs are journal/contra kinds).

Fixed at the rule, not the symptom: `buildLegs` now takes
`settleCode: string | null` and refuses null only for the kinds that actually
settle; the action passes null for the other four. Two regression tests in
`test/vouchers.test.ts` pin both halves. **Take the lesson in EVOLUTION #44
delta 2 into every later phase: when a lenient parse becomes strict, enumerate
its callers by FORM FIELD, not by function signature.**

## Verified in a real browser (isolated scratch instance)

Scratch at `~/rvos-p0c-scratch` (copied `src` + copied `node_modules`, its own
`data/`), Playwright, owner and clerk logins. Delete it when you no longer want
it — it is ~480MB and NOT gitignored anywhere useful.

- Added/renamed/archived a centre through the real forms; duplicate code refused
  as a sentence; audit rows written with the owner as actor.
- Posted a purchase with a centre: `5000` expense leg carries it, `1300` ITC and
  `2100` AP do not. Verified in the DB, not in the UI.
- Review grid: tagged a sale row, saved the draft, reloaded, tag persisted.
  Cells disabled on `opening/receipt/payment/other` rows, enabled on
  `sale/purchase/credit_note`.
- Clerk: every submit on `/settings/cost-centres` disabled, keeps "Save draft"
  and no "Save & post", still sees the settings card (same as the chart of
  accounts — read-only, not hidden).

## OPEN / next

- **Ship-gate agents not run for P0c** — the mechanical gate (tsc, eslint,
  tests, smoke, build) is green and the browser pass is done, but
  `code-reviewer` and `qa-runner` were not dispatched this session. Run both
  against the P0c commit before treating Stage 0 as closed.
- **Stage 0 end-to-end check from the plan** (§Verification) is only partly
  done: two bank accounts + petty cash posting independently, and the
  balance-sheet listing them separately, has not been re-run since P0a.
- Review grid needs horizontal scrolling in the photo-review pane (~700px
  wide, table floor now 1010px with the centre column, 920px without). It was
  already scrolling before P0c. If it starts to annoy, the fix is the document
  page's `lg:grid-cols-[minmax(260px,340px)_1fr]`, not the table.
- **NEXT PHASE: Stage 1, P1 — bill-wise allocation** (`src/lib/bills.ts`,
  migration 007). `bills` written INSIDE the existing posting transactions — no
  third posting path — plus `bill_allocations`, `assertAllocationSane`'s two
  guards, and a backfill of bills for existing sale/purchase/opening journals so
  aging works on the real book. Then P2 (aging/bank rec/account ledger), P3
  (items), P4 (orders — never post), P5 (conversion), P6 (print).

## GOTCHA — read before touching the dev server again

`DEMO_MODE=1` only fakes the LLM call. It does NOT change `DATA_DIR`
(`db.ts` resolves it from `process.cwd()`). Running `npm run dev` from
`~/revenueos` itself, even with `DEMO_MODE=1`, boots against the REAL
`data/revenueos.db` and runs any pending migration on it in-process with no
pre-migration backup.

**This session:** a dev server from a PREVIOUS session was found still running
with `cwd = ~/revenueos` (`next dev -p 3322 -p 3323`), serving page loads
against the live book. A fresh backup was taken before migration 006 was
written — `data/backups/revenueos-20260812-224657`, sha256 `e9c0f5e5…` — and
the live db was still at migration 005 when last checked, so 006 has NOT been
applied to it. Migration 006 is purely additive, but **stop that server before
booting anything else against the repo**.

The genuine pre-004 rollback point is `revenueos-20260808-005733`. Full account
of the earlier 004-on-the-live-ledger incident in EVOLUTION #38.

**For any future "let me just check this in a browser":** use a fully separate
directory. Turbopack rejects a SYMLINKED `node_modules` ("points out of the
filesystem root") — copy it, or `npm ci` there; `src` and config files must be
copied, not symlinked, either way. Mint a session directly via `createSession()`
and never touch `data/revenueos.db`.

## Standing rules for every remaining phase

- New table → `SCOPED_TABLES` in `book.ts` immediately + a cross-company
  isolation test shaped like `test/import-isolation.test.ts`,
  `test/bank-accounts.test.ts` or `test/cost-centres.test.ts`.
- `exportCompany` (`backup.ts`) iterates `SCOPED_TABLES` automatically — new
  tables export for free. Still verify per phase with a real round trip.
- Ship gate per phase: tsc, eslint, `npm test`, `DEMO_MODE=1 npm run smoke`,
  `npm run build`, then code-reviewer + qa-runner, zero blockers both.
- **A browser pass on any phase that touches a form.** Three phases, three
  defects no other gate could see (EVOLUTION #38, #40, #44).
- One `EVOLUTION.md` entry per phase, or an explicit "no failures."
- Orders never post (P4) — pinning test required when that phase lands.
- Rewrite THIS file at every phase boundary; hard-stop at ~60% context for a
  `/clear` + resume rather than trusting auto-compact mid-phase.
