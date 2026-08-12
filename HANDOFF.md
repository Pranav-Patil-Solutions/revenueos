# RVOS-006/007/008 HANDOFF — ACTIVE (resume here)

Task: turn RevenueOS from a correct ledger engine into a complete finance
department. Full 23-phase program in the approved plan at
`~/.claude/plans/bubbly-frolicking-prism.md` — read that first, this file is
just "where am I right now."

Repo `~/revenueos`. Port 3322 only. `DEMO_MODE=1` for tests/smoke — **but see
GOTCHAS, `DEMO_MODE` does NOT sandbox the database.** Never point a dev server
at `~/revenueos` as `cwd` for throwaway QA; use a genuinely separate directory.

Branch: `feat/rvos-006-finance-foundation`, off `feat/companies-visual-redesign`
@ `e4803d4` (that redesign is committed, not part of this branch's own work).
`master` is further behind still (pre-multi-company) — not this ticket's problem.

## DONE (P0a — real bank accounts, RVOS-006 Stage 0)

**Committed.** Ship gate closed: `code-reviewer` returned 0 blockers + 2
warnings (both fixed, see below); `qa-runner` added two multi-account posting
tests before being cut off by an API session limit, so the remainder of its
sweep was completed directly instead of re-dispatching an agent.

Replaced the hardcoded `settle_account TEXT CHECK (IN ('cash','bank'))` enum
— 58 call sites, exactly two ledger codes — with a real `bank_accounts` table
(migration 004 in `src/lib/migrations.ts`), each account owning its own
chart-of-accounts ledger. `staged_rows.settle_account` → `bank_account_id`.

- New `src/lib/bank-accounts.ts`: `listBankAccounts`, `createBankAccount`,
  `renameBankAccount`, `setDefaultBankAccount`, `archiveBankAccount`,
  `resolveSettleCode`, `defaultForHint`. Archive-only (house rule), refused on
  the LAST account of a kind — a future import would have nowhere to resolve.
- Ingestion paths (LLM photo, CSV template) still only produce a coarse
  cash-vs-bank `SettleHint` — nothing upstream can know WHICH account a khata
  line means — resolved at staging time via `defaultForHint`. **Tally is the
  exception**: it names the real ledger a voucher settled through, so
  `import-tally.ts` resolves an actual `bank_account_id` via
  `MappedAccount.bank_account_id`, not a hint.
- `buildLegs` (`posting.ts`) now takes a resolved ledger code as a 4th
  argument instead of reading an enum — stays pure/testable.
- `seedAccountsForCompany` (`db.ts`) now also wraps a NEW company's seeded
  Cash/Bank in `bank_accounts` rows, so onboarding post-migration doesn't
  strand a book with nothing to resolve to.
- New `/settings/bank-accounts` page (add/rename/set-default/archive), wired
  into voucher-form.tsx (contra + structured + TDS voucher selects) and
  review-table.tsx (per-row account picker in the review grid).
- Tests: `test/bank-accounts.test.ts` (new, 12 cases — isolation, defaults,
  archive-refusal, ledger-naming) plus two `postDocument` cases proving three
  rows on three different accounts each hit their OWN ledger, and that an
  account archived between staging and posting still posts. **391/391 pass**,
  tsc/eslint/build/smoke all green.
- Real browser pass on an isolated scratch instance: created a second account
  (ledger 1110), renamed it, made it default, archived the now-non-default
  seeded "Bank", and confirmed the voucher "Settled via" list then showed
  exactly `1110 …` + `1000 Cash` with the archived account absent. It caught a
  layout defect no gate here could: the name `<input className="w-full">` in a
  flex row collapsed to 18px (flex items default to `min-width:auto`), leaving
  the name unreadable — fixed via `min-w-0 flex-1` + `shrink-0`, re-measured at
  164px with no table overflow.
- ~~Known verification gap: contra between two real bank accounts~~ **CLOSED**
  — two tests added (bank→bank across two ledgers with totals provably
  unchanged, plus cross-company refusal), mutation-tested to confirm they
  actually catch a leg-collapse regression. **393/393 pass.**
- Code-reviewer warnings fixed: (1) `applyDraftRows` now checks
  `bank_account_id` OWNERSHIP via `getBankAccount` for every draft row, since
  `saveDraft` never reaches `postDocument`'s scoped check and would otherwise
  persist another company's account id; (2) the Tally fallback account is now
  genuinely lazy (it was an IIFE that ran on every import).
- `EVOLUTION.md` #38 written (includes the GOTCHA below — read it in full).

## DONE (P0b — attribution, roles, audit log)

**Committed.** Migration 005: `journals.created_by`, `auth_users.role`
(owner/accountant/clerk/viewer), append-only `audit_log`. 412/412 pass,
tsc/eslint/smoke/build green. Full reasoning in EVOLUTION #39.

- `src/lib/roles.ts` — capability matrix as pure data. `dal.ts` is the ONLY
  enforcer (`requireBook(capability)`, `assertCan`, `userCan`).
- The actor rides on the `Book` handle (`book(db, companyId, actorUserId)`), so
  attribution flows from the session and no posting call site can forget it.
  `null` = genuinely no signed-in user (migration/CLI/test), rendered as
  "unknown", never backfilled to a guess.
- `audit_log` append-only via SQL TRIGGERS; written INSIDE the posting
  transaction so a rolled-back post leaves no row.
- All 24 actions in actions.ts carry an explicit capability, and a new ratchet
  in `test/route-guards.test.ts` fails if any future one omits it.
- `src/lib/staff.ts` — listStaff/createStaff/setStaffRole, refusing to demote
  the LAST owner (unrecoverable lockout: no reset email, no support channel).

**P0b UI — DONE (second commit).** 413/413 pass, browser-verified.
- `/settings/staff` — add staff, change roles, role legend. Self-role is frozen
  (you cannot demote yourself: undoing it needs the permission you'd give away)
  and so is the last owner, each with the reason shown in the row.
- `/settings/audit` — the trail, newest first, NULL actor rendered "unknown".
- Audit now also covers company settings, books lock, and all four
  bank-account mutations (written inside their existing transactions).
- Settings nav gates the Staff card on `userCan(user, "users.manage")`, and the
  page itself renders an owners-only panel rather than throwing a 500 — Next's
  `forbidden()` is still behind the experimental `authInterrupts` flag, which
  is not a trade worth making here.
- Browser-verified with two real logins: a clerk sees no Staff card, gets the
  refusal panel on direct navigation with NO staff data in the DOM, and can
  still read the audit trail.

**STILL OPEN from P0b:**
- TDS challan (`createTdsChallan`) posts a journal but writes no audit row —
  the one remaining unlogged mutation. One `writeAudit` inside its transaction.
- Role-aware hiding is done for the Staff card only. Post buttons (Vouchers,
  the review grid's Post, depreciation) still render for a `clerk` and will
  throw a readable error on click rather than being hidden. `userCan()` is
  there for it.

## GOTCHA — read before touching the dev server again

`DEMO_MODE=1` only fakes the LLM call. It does NOT change `DATA_DIR`
(`db.ts` resolves it from `process.cwd()`). Running `npm run dev` from
`~/revenueos` itself, even with `DEMO_MODE=1`, boots against the REAL
`data/revenueos.db` and runs any pending migration on it in-process with no
pre-migration backup — this happened once already this session (migration
004 applied to the live ledger by accident; verified intact afterward —
integrity_check ok, fk_check clean, journal balance 0 paise, all 48 staged
rows mapped). A snapshot dated ~2 min AFTER the migration exists at
`data/backups/revenueos-20260810-114804`; the genuine pre-004 rollback point
is the older `revenueos-20260808-005733`. Full account in EVOLUTION #38.

**For any future "let me just check this in a browser":** use a fully
separate directory, real `npm ci` install there, `src`/config files COPIED
not symlinked (Turbopack's root-escape check rejects a symlinked `src` or
config file even though a symlinked `node_modules` is fine). Mint a session
directly via `createSession()`, never touch `data/revenueos.db`.

## NEXT (in order — see the plan file for full detail per phase)

- **Finish P0b's UI** — the four items under "REMAINING P0b work" above.
- **P0c** — cost centres (migration 006). Nullable `journal_lines.cost_centre_id`,
  threaded through both posting paths now so every later phase writes it
  natively.
- Then Stage 1 (P1–P6, bill-wise/aging/items/orders — the original RVOS-006
  ask), Stage 2 (P7–P11, treasury/void/disposal), Stage 3 (P12–P14, GSTR-2B/
  ITC recon), Stage 4 (P15–P16, budgets/MIS), Stage 5 (P17–P20, payroll).

## Standing rules for every remaining phase

- New table → `SCOPED_TABLES` in `book.ts` immediately + a cross-company
  isolation test shaped like `test/import-isolation.test.ts` or the new
  `test/bank-accounts.test.ts`.
- `exportCompany` (`backup.ts`) iterates `SCOPED_TABLES` automatically — new
  tables export for free, confirmed this phase. Still verify per phase.
- Ship gate per phase: tsc, eslint, `npm test`, `DEMO_MODE=1 npm run smoke`,
  `npm run build`, then code-reviewer + qa-runner, zero blockers both.
- One `EVOLUTION.md` entry per phase, or an explicit "no failures."
- Orders never post (P4) — pinning test required when that phase lands.
- Rewrite THIS file at every phase boundary; hard-stop at ~60% context for a
  `/clear` + resume rather than trusting auto-compact mid-phase.
