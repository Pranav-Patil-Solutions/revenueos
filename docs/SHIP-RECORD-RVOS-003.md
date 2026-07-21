# RevenueOS — RVOS-003 Client Delivery · ship record

**Date:** 2026-07-21 · **Master:** `1dbe814` (pushed) · **Tests:** 314 · smoke GREEN

Target: Dad's accounting office, on **their own Windows machine**, single
company, **their own** Claude CLI subscription, reachable over **their**
Tailscale.

---

## What shipped

| Phase | What |
|---|---|
| **P1** | FY 2025-26 verified from gazette text; verification now **per field-group per year** |
| **P2** | **Authentication** — there was none before |
| **P3** | **Backups + restore**, and a WAL checkpoint on every connection open |
| **P4** | Windows installer + preflight — **WINDOWS-UNVERIFIED** |
| **P5** | Network bind policy — loopback by default |
| **P6** | `docs/DAY-ONE.md`, the runbook for the office |

Gates: three zero-context code reviews and two qa-runner drives. Every blocker
fixed. Blockers they caught that I had missed:

1. An **open redirect** in the post-login `next` target — `/\evil.com`
   normalises to `http://evil.com/`, and `/login` is public, so it fired
   *after* the victim authenticated.
2. The proxy answered `/api` with a **307 redirect instead of 401**, so the
   route handlers were correct but unreachable. Only an HTTP drive could see
   that; the unit tests are static.
3. **Restore never restored the ledger photos**, so every `documents.image_path`
   would have pointed at a missing file.
4. Restore **was not atomic**, and its failure message never named the book it
   had just preserved — a failed restore read like total loss.
5. LAN addresses were allowed **on a warning** from an app that runs under a
   Scheduled Task where nobody reads the console.

---

## ⚠ The live ledger was destroyed and recovered

`data/revenueos.db` had been a 4 KB stub with **no tables** since 2026-07-16 —
the whole book lived in an uncheckpointed `-wal`. A QA agent, following *my*
instruction to "restore the .db to this sha256", deleted the sidecars. The hash
matched because the file it hashed was empty.

Recovered in full from a prior session's scratch directory, checkpointed into
the main file, and asserted back to baseline: **6 documents · 9 journals ·
27 lines · 2 parties · 23 accounts · trial balance 0**.

**The rule, now enforced in code and written into EVOLUTION #23:** a `.db` and
its `-wal`/`-shm` are ONE database. Verify by **content**, never by the
byte-identity of one file. And more generally — *a verification whose passing
state is indistinguishable from its failure state is not a verification.*

---

## Open — and NOT closable by Claude

### 1. Windows acceptance (invariant N3)
The installer was authored on macOS and **has never executed on Windows**. The
314 passing tests are not Windows coverage. Ship day, with Pranav present:

- [ ] Install from clean: `powershell -ExecutionPolicy Bypass -File install\windows\setup.ps1`
- [ ] Reboot — confirm it starts at sign-in
- [ ] Create the office account (there is no default password by design)
- [ ] `claude login` on **their** account — confirm it is theirs, not the installer's
- [ ] `REVENUEOS_BACKUP_DIR` → external drive, then `npm run backup`
- [ ] **`npm run restore -- --list`** — the drill, while nothing is wrong
- [ ] Extract one real ledger photo
- [ ] Tailnet: `tailscale ip -4` → set `REVENUEOS_BIND` → reach it from a phone

Most likely failure: `better-sqlite3` is a native module needing a binary that
matches their Node ABI. Fallback is in `setup.ps1`.

### 2. The s.44AD / 44ADA / 44AE percentages
Deemed profit **8% / 6% / 50%** are the only figures nobody has confirmed —
for *either* year. The app says so on every presumptive computation. To close:
read the sections, add citations to `RATE_VERIFICATION` in
`src/lib/tax/india-it.ts`. The machinery is already there.

---

## Deliberately not modelled — documented, not guessed

GSTR-9/9C (FY 2025-26 → 31 Dec 2026) · QRMP dates (state-dependent, 22nd/24th)
· TDS on partner remuneration (194T) · the ₹400 crore company turnover test
(app always applies 25%) · the 15% surcharge cap on special-rate income ·
s.87A's second proviso · due-date extensions by notification.

---

## What P1 settled

- **FY 2025-26 is a 1961-Act year** — confirmed twice, independently, from
  gazette PDFs.
- **20 of 21 claims survived** two adversarial passes told to refute.
- **The 31 August ITR tier is adopted.** I had held 31 July as "conservative";
  that was wrong by a month. The statutory test is **income-based** — "assessee
  having income from profits and gains of business or profession whose accounts
  are not required to be audited" — so a **non-audited firm** qualifies. The
  popular "31 Aug = ITR-3/ITR-4" gloss is form-based and wrong.
- **An FY 2025-26 book-profit computation now renders caveat-free.** It
  previously warned about everything, because one boolean covered ~15 groups.
- **FY 2026-27 had been over-claiming** — presumptive was never confirmed for
  it either, and is now flagged for both years.

Two secondary sources were caught being wrong: a widely-ranked chart asserting
the 37% surcharge applies under the new regime (it caps at 25%), and the tax
department's own site serving **obsolete versions of sections** at plausible
URLs that outrank the current ones.
