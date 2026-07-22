# RVOS-004 — Multi-client books · Build Spec
# Owner: Pranav · Repo: ~/revenueos · Branch: feat/rvos-004-multi-client
# Ports: dev 3322 ONLY · DEMO_MODE=1 for all tests/smoke

## PRODUCT
Dad signs in ONCE and switches between the books of every client his office
keeps. Today the app is one company, enforced in the schema
(`settings CHECK (id = 1)`, zero of 17 tables carry a tenant column), so every
signed-in user sees the same ledgers.

Still local-first. This does NOT need Vercel and must not become a cloud app:
keeping it on the office machine preserves the `claude` CLI transport (no API
key, no per-extraction cost), keeps client financials off the public internet,
and keeps the RVOS-003 backup/restore story intact. Remote access is already
solved by Tailscale (RVOS-003 P5), behind the login.

## THE INVARIANT THIS BUILD BREAKS — read before starting
RVOS-002/003 held: *"Schema evolves additively: ensureColumn() + CREATE TABLE
IF NOT EXISTS. No migration framework."*

**Multi-tenancy cannot be additive.** It needs `company_id NOT NULL` on
existing populated tables, and it needs UNIQUE constraints re-scoped. And
`CREATE TABLE IF NOT EXISTS` NEVER revisits an existing table, so a redefined
constraint is a silent no-op on the client's live database (spec risk #3 of
RVOS-002, and the cause of a real defect there).

So P1 introduces the repo's FIRST real migration. It must be:
- **versioned** (`schema_version` table, forward-only, each step idempotent),
- **backed up first** — call the RVOS-003 backup path before any DDL, refuse
  to migrate if the backup fails verification,
- **table-rebuild based** where a constraint changes: create the new table,
  copy, verify row counts AND a zero trial balance, drop, rename — inside ONE
  transaction,
- **reversible in practice** via the pre-migration snapshot, which the operator
  is told about by path.

## INVARIANTS (violating any = blocker)
Inherited and still binding:
- All money INTEGER paise; journals balanced by construction; post-only.
- LLM transport = `claude` CLI only. NEVER @anthropic-ai/sdk / ANTHROPIC_API_KEY.
- Next 16: `params`/`searchParams`/`cookies()` are Promises — await them.
- Every server action starts with `requireSession()`; route handlers use
  `requireApiSession()`; pages guard themselves (layouts do not protect).
- A `.db` and its `-wal`/`-shm` are ONE database (EVOLUTION #23).

New, and the whole point of this build:
- **T1 — No query may read or write rows of a company other than the active
  one.** Enforced structurally, not by discipline (see P2), and proven by the
  isolation suite (P6). This is the single blocker-level invariant here: a
  tenancy leak in an accounting system means one client seeing another's
  turnover, PAN and GSTIN.
- **T2 — The active company lives in the SESSION, never in a URL or a form
  field.** A `?company=7` parameter is an IDOR waiting to happen. Switching
  companies is an authenticated action that rewrites session state.
- **T3 — Cross-company aggregation is forbidden by default.** Any future
  "all clients" view is a separate, explicitly-reviewed feature, not an
  accident of a missing WHERE clause.

## PHASES (each: tests+smoke+lint+build green → code-reviewer on the diff →
## commit "RVOS-004 P<n>: …" → update HANDOFF.md)

P1 **Migration engine + companies table**
   `schema_version` (forward-only, idempotent steps). `companies` (id, name,
   entity_type, pan, tan, gstin, state_code, and the rest of today's per-book
   settings — `settings` becomes a per-company row, so its `CHECK (id = 1)`
   goes). Migration 001: create `companies`; insert the EXISTING book as
   company 1 named from `settings.company_name`; add `company_id` to all
   scoped tables defaulting to 1; then rebuild each table that needs it to make
   the column NOT NULL and re-scope its UNIQUE constraints.
   **Re-scoped uniqueness — these are where a naive migration breaks:**
   - `accounts.code` UNIQUE → UNIQUE(company_id, code)
   - `ledger_mappings.ledger_name` UNIQUE → UNIQUE(company_id, ledger_name)
   - `compliance_marks` UNIQUE(rule_code, period) → +company_id
   - `wdv_openings` UNIQUE(fy, block) → +company_id
   Scoped tables: settings→companies, accounts, parties, documents,
   staged_rows, journals, journal_lines, tds_entries, tds_challans,
   it_adjustments, tax_payments, fixed_assets, wdv_openings, compliance_marks,
   ledger_mappings. NOT scoped: auth_users, auth_sessions (firm staff are
   global — see P3), schema_version.
   Test: migrate a COPY of a real single-company db; assert row counts, a zero
   trial balance, and that every pre-existing row landed on company 1.

P2 **Structural scoping — the mechanism, before any UI**
   Do NOT rely on remembering a WHERE clause in 60 call sites. Introduce a
   `Book` handle: `book(db, companyId)` returning the query surface, where
   every statement is prepared with `company_id = @company_id` bound at the
   handle, not passed by callers. Port `reports.ts`, `posting.ts`,
   `vouchers.ts`, `compliance.ts`, `tax/*.ts` and the importers onto it.
   **Guard test (static, like route-guards.test.ts):** no file under
   `src/lib/` may call `db.prepare(` directly on a scoped table outside
   `book.ts` — walk the source and fail on violations. That test is what keeps
   this true for code nobody has written yet.

P3 **Session-bound company + switcher**
   `auth_sessions.company_id` (nullable = none chosen). `switchCompany(id)` is
   a server action: verifies the company exists, rewrites the session row,
   redirects. The DAL returns `{user, companyId}`; `requireSession()` gains a
   companion `requireBook()` that 4xx/redirects when no company is selected.
   Company picker in the topbar (the topbar already prints company name —
   it becomes the switcher). A `/companies` page to create, rename and
   archive. Deleting a company is NOT offered: archive only, because deleting
   a client's books is not an action to expose behind a button.
   Per T2: no company id in any URL or form field.

P4 **Onboarding a new client**
   Create-company flow: name, entity type, PAN/TAN/GSTIN, state code, FY, then
   seed that company's own chart of accounts (today's SEED_ACCOUNTS, per
   company). Opening balances via the documented `opening` journal
   (docs/DAY-ONE.md §4). Tally/CSV import must land in the ACTIVE company —
   an import that silently posts into the wrong client's books is the worst
   failure this app can have; pin it with a test.

P5 **Backups, per company and whole-office**
   `npm run backup` keeps backing up the whole database (all clients at once —
   simplest and safest). ADD a per-company export for handing a client's books
   to their own CA. `verifyBackup` gains a per-company row-count assertion.
   The CA pack, exports and every report already run per company via P2.

P6 **Isolation suite — the ship gate for this build**
   Seed TWO companies with deliberately distinguishable data (different
   parties, amounts, FYs, GSTINs). Then, ENUMERATED FROM THE EXPORTS rather
   than a hand-written list, assert for every reporting/query function that a
   call scoped to company A returns nothing belonging to company B: trial
   balance, day book, P&L, balance sheet, GSTR-1/3B, party statements,
   depreciation, computation, TDS register + 26Q/24Q, compliance board, CA
   pack, every CSV/JSON export.
   Plus: a company with NO data returns empty, never company 1's rows; the
   books-lock, FY selector and settings are per company; and switching
   companies mid-session cannot leave a cached handle pointing at the old one
   (React `cache()` is per-request — pin it).

## SHIP GATE
1. npm test + smoke + lint + build green.
2. code-reviewer on the FULL branch diff: 0 blockers, with an explicit pass
   over tenancy leakage.
3. qa-runner drives :3322 with TWO companies: create both, post in each,
   confirm every report and the CA pack show only the active company, and that
   switching is visible in the topbar.
4. **Migration rehearsed on a COPY of the office's real database**, with the
   pre-migration snapshot verified restorable BEFORE the real run.
5. EVOLUTION updated (#26+).

## RISKS
- R1 **A tenancy leak is the whole risk.** It is silent, it is discovered by a
  client, and it is unrecoverable reputationally. P2's structural approach and
  P6's enumerated suite exist for this and must not be traded away for speed.
- R2 The migration touches populated tables holding real books. Rehearse on a
  copy; back up first; refuse to proceed on a failed backup.
- R3 Scope creep into per-staff permissions ("the junior may only see clients
  X and Y"). NOT in this build — all authenticated staff see all companies.
  Note it in the UI so nobody assumes otherwise.
- R4 Reports that currently assume one company may have implicit
  single-book assumptions beyond the WHERE clause (e.g. retained-earnings
  injection in the balance sheet). Re-read each during P2 rather than only
  adding a filter.
