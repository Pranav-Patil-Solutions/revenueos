# RVOS-003 — RevenueOS Client Delivery · Build Spec
# Owner: Pranav · Repo: ~/revenueos (local + private remote origin/master)
# Branch: feat/rvos-003-client-delivery · master stays shippable, merge only after ship gate
# Ports: dev 3322 ONLY · DEMO_MODE=1 for all tests/smoke (never burn subscription)

## PRODUCT
Take the shipped Accountant Edition and make it a thing a real accounting office
RUNS — installed on their Windows machine, reachable over their Tailscale, logged
in to, backed up, and correct for the year they are actually filing.

Delivery target (decided 2026-07-21):
- HOST: the office's own WINDOWS machine (not Pranav's Mac).
- SCOPE: ONE company — Dad's office books. Multi-tenant stays out (RVOS-004).
- LLM: the CLIENT's own Claude subscription, `claude` CLI authenticated on THEIR
  machine. Pranav's account is never the transport for their usage.
- ACCESS: that machine + remote over Tailscale ⇒ auth is MANDATORY (see P2).

## INVARIANTS (violating any = blocker)
Inherited from RVOS-002, still binding:
- All money INTEGER paise. No floats in db or posting math.
- Journals balanced by construction: assertBalanced → SQL CHECK → trialBalance()==0.
- Post-only / fix-forward. Posted docs locked. Books-lock inclusive.
- LLM transport = `claude` CLI via src/lib/llm-cli.ts ONLY. NEVER @anthropic-ai/sdk
  / ANTHROPIC_API_KEY.
- Schema evolves additively: ensureColumn() + CREATE TABLE IF NOT EXISTS. No
  migration framework. (CREATE TABLE IF NOT EXISTS never revisits an existing
  table — a CHECK added later is a no-op on the client's live db.)
- Statutory data carries `verified` + `source`; banners are driven BY THE FLAGS.
- Next.js 16: params/searchParams are Promises — always await.

New to this build:
- N1 **Auth gates the bind.** The server MUST NOT listen on anything but 127.0.0.1
  until P2 is merged. Binding 0.0.0.0 with no login exposes a full book of client
  financials to the tailnet. Ordering is a blocker, not a preference.
- N2 **A backup is not verified by existing — it is verified by RESTORING.** Every
  backup phase ships a restore that is actually executed against a scratch dir and
  asserted row-for-row. An untested backup is a lie told to a client.
- N3 **Windows claims are UNVERIFIED until run on Windows.** This build is authored
  on macOS. Anything touching native modules, paths, or autostart ships labelled
  `WINDOWS-UNVERIFIED` in HANDOFF until Pranav runs it on the office machine. Do
  not let the ship gate's green tests imply Windows coverage — they do not.
- N4 **No secret in the repo.** The client's password hash, session secret and any
  Tailscale identity live in `data/` or env, never committed. `data/` is gitignored
  and stays that way.

## PHASES (each: tests+smoke+lint+build green → code-reviewer on the diff →
## commit "RVOS-003 P<n>: …" → update HANDOFF.md)

P1 **FY 2025-26 verification** — THE SHIP-CRITICAL ITEM. Today is 2026-07-21;
   the office's live work is FY 2025-26 (AY 2026-27), the one year still
   `verified: false`. It is a 1961-Act year as amended by Finance Act 2025 —
   DIFFERENT slabs, rebate, surcharge and TDS thresholds from the 2026-27 year
   verified in EVOLUTION #19. Apply that same protocol: primary gazette text (not
   a chart), FY-vs-AY basis stated per figure, independent adversarial re-check of
   every claim, citation into `source`, corrected values pinned by tests so a
   silent revert fails loudly. Touches india-it.ts TAX_YEARS["2025-26"],
   tds.ts TDS_SECTIONS (FA 2025 raised thresholds w.e.f. 1 Apr 2025 — the app's
   sections are keyed to the 2026-27 values and MUST become year-aware if the two
   years differ), compliance.ts RULES (1961-Act due dates + form numbers 26Q/24Q,
   NOT the Rules-2026 renumbering). Anything that cannot be pinned to a primary
   source STAYS `verified: false` — the banner is the honest output.
   ⚠ If TDS thresholds differ between FY 2025-26 and FY 2026-27, TDS_SECTIONS
   gains a year axis. That is a real engine change, not a data edit — spec it,
   test both years, and re-verify the 2026-27 pins still hold.

P2 **Auth** — the app currently has ZERO auth; Tailscale was the whole perimeter.
   Remote access means a login. Password (Argon2id or scrypt via node:crypto —
   no new dep if avoidable) hashed into a `auth_users` table or a settings field;
   httpOnly + sameSite=lax + secure-when-https session cookie, signed with a
   secret generated on first run into `data/`; middleware gating EVERY route
   except the login page, the health check, and static assets — default-deny, an
   allowlist of public paths, never a denylist. Rate-limit failed attempts.
   Logout. Session expiry + rolling renewal. Tests: unauthenticated GET of every
   sensitive route (books, reports, pack, exports, API, server actions) returns
   401/redirect — enumerate them from the router, not by hand.

P3 **Backups + restore** — client books whose only copy is one Windows machine.
   `scripts/backup.ts`: SQLite online backup API (never a file copy of a live WAL
   db), timestamped, to a configurable dir; retention (keep N daily / M weekly);
   `data/uploads/` included; integrity-check each backup (`PRAGMA integrity_check`)
   before it counts as good. `scripts/restore.ts` with an explicit confirm.
   Per N2: the test RESTORES a backup into a scratch dir and asserts the row
   counts and trial-balance zero match the source. Scheduled via the P4 installer.
   Document an offsite step (their own drive/cloud) — a backup on the same disk
   as the db survives nothing.

P4 **Windows install path** — `install/windows/` : a PowerShell setup script
   (Node LTS check + version pin, `npm ci`, better-sqlite3 native resolution —
   prefer a prebuilt matching their Node ABI, document the MSVC fallback),
   production build, first-run init, a Scheduled Task for autostart-at-logon,
   a second task for the P3 backup, a `.bat` launcher, and an uninstall. Plus
   `scripts/preflight.ts`: Node version, native module loads, `data/` writable,
   disk space, port 3322 free, and — per the LLM decision — `claude` CLI present
   AND authenticated, with a clear actionable failure ("run `claude login` on this
   machine") rather than a cryptic extraction error at the first photo. All of
   P4 ships `WINDOWS-UNVERIFIED` per N3.

P5 **Tailscale binding** — only after P2 is merged (N1). Bind host configurable,
   defaulting to 127.0.0.1; an explicit opt-in to the tailnet IP. Verify phone
   capture (`/capture`) works over their tailnet. Document that Tailscale is now
   defence-in-depth BEHIND the login, not the perimeter itself.

P6 **Onboarding + docs** — the day-one runbook the office actually follows:
   settings (company, entity type, PAN/TAN/GSTIN, state code, FY, regime),
   chart-of-accounts review, and the OPENING BALANCE entry (account 3000 Opening
   Balance Equity + the `opening` entry type via a free-form journal — this path
   exists but is undocumented and is the single most likely day-one stumble).
   Then: bringing existing books in via Tally XML / CSV, the backup + restore
   drill, what every caveat banner means and who is allowed to flip a `verified`
   flag. FIX THE STALE README CLAIM — it still says "Every statutory rate and due
   date ships verified: false", which became false at `76f023a`.

## SHIP GATE (all five, no exceptions — money + a real client)
1. npm test + smoke + lint + build green.
2. code-reviewer on the FULL branch diff: 0 blockers. Auth and backup get their
   own focused pass — they are the two things with no prior art in this repo.
3. qa-runner drives :3322: books/reports/pack unchanged by auth, login enforced,
   backup→restore round-trips.
4. EVOLUTION.md updated (#20+).
5. **Windows acceptance on the office machine, with Pranav present**: install from
   clean, autostart survives reboot, login works over the tailnet, a backup runs
   and is restored, `claude` CLI extracts one real photo on the CLIENT's account.
   Only this step clears N3 — nothing before it may be reported as Windows-ready.

## RISKS
- R1 Windows native module (better-sqlite3) is the most likely install failure.
  Pin Node version; have the prebuilt-binary path AND the build-tools fallback
  written before install day.
- R2 P1 may prove FY 2025-26 differs from FY 2026-27 on TDS thresholds, forcing a
  year axis through TDS_SECTIONS and every caller. Budget for it.
- R3 Auth touches every route; the failure mode is a route left unguarded. Derive
  the guarded set from the router, default-deny.
- R4 The client's real books arrive with opening balances that must tie out. The
  first trial balance after onboarding is the acceptance test, not a formality.
