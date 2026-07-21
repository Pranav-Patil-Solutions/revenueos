# RevenueOS

The finance department in a box for SMBs. Photograph a customer/supplier ledger
page (handwritten Indian khata or printed statement) → AI extracts the rows →
you review and correct them on screen → they post to proper double-entry books →
statements, trial balance, P&L, and monthly GST filing-prep summaries with
CSV/JSON export.

Local-first on this Mac. Your phone reaches it over LAN/Tailscale for camera
capture. No cloud, no API keys, no data leaves the machine.

## Stack

Next.js 16 (App Router) · React 19 · better-sqlite3 (WAL) · Tailwind v4 tokens ·
`claude` CLI as the vision/LLM transport (subscription-billed — **zero API
credits are used; never introduce `@anthropic-ai/sdk` or `ANTHROPIC_API_KEY`**).

All money is INTEGER paise end to end. Journals are balanced by construction
(`assertBalanced` before insert → SQL CHECKs → `trialBalance()` zero assert).

## Setup

```bash
npm install
npm run dev        # http://localhost:3322  (ports 3000/3311 belong to other apps)
```

- Database: `data/revenueos.db` (created + seeded on first request: 13-account
  chart, settings singleton). Uploads land in `data/uploads/`. Both gitignored.
- Settings → set your company name, GSTIN, and state code (default 27,
  Maharashtra). State code drives CGST+SGST vs IGST.
- Real extraction shells out to the locally authenticated `claude` CLI
  (model: `REVENUEOS_EXTRACT_MODEL`, default `claude-sonnet-5`).

## Demo mode (no subscription burn)

```bash
DEMO_MODE=1 npm run dev
```

Extraction short-circuits to a canned 11-row Sharma Traders khata page
(sales, receipts, a credit note, a purchase, a payment, an illegible row, a
balance row). Demo parties are seeded automatically. Post it (exclude the
illegible row) and every report lights up with verifiable numbers:
AR ₹12,580.00 · GSTR-3B outward ₹16,000.00, CGST/SGST ₹1,290.00 each,
ITC ₹900.00, payable ₹1,680.00.

## Phone capture over Tailscale

Open `http://<tailscale-ip-of-this-mac>:3322/capture` on your phone. The
capture button uses a file input with `capture="environment"` — it opens the
camera directly and works over plain HTTP (no secure-context requirement,
unlike getUserMedia). Every shot is normalised **in the browser** before
upload — decoded, downscaled to a 2400px long edge, EXIF orientation baked into
the pixels, and re-encoded to JPEG. iPhone HEIC decodes natively on iOS Safari,
so no camera-format change is needed; you also get a preview + Retake before the
page burns an extraction round on a blurry shot.

## Pipeline

1. **Capture** — photo + party. The browser normalises the shot (HEIC-safe,
   downscaled, upright JPEG) and shows a preview → `POST /api/upload` (15MB cap,
   sha256 duplicate-page warning).
2. **Extract** — `POST /api/documents/<id>/extract` (also fired by the UI).
   Headless Claude reads the photo via its Read tool and returns strict JSON;
   one retry with the validation error quoted back. Re-extract freely until
   posted.
3. **Review** — editable grid: dates, amounts, entry types, GST rate,
   cash/bank, include-checkboxes. Balance rows come pre-excluded; low
   confidence rows are tinted (warning < 0.7, critical < 0.4).
4. **Post** — one transaction, one journal per included row. Posted documents
   are read-only; v1 is post-only (fix forward with an opposite entry).
5. **Report** — dashboard, statements with running balances, trial balance
   (zero-check badge), day book, P&L, GSTR-3B / GSTR-1 B2B for any month.

Exports: `/api/export/<report>?format=csv|json[&month=YYYY-MM][&party=<id>]`
for `trial-balance`, `day-book`, `pnl`, `gstr-3b`, `gstr-1`, `statement`.

## Accountant Edition (RVOS-002)

Everything an accounting office runs after the books, built on the same
posting engine:

- **Statements** — P&L for any FY, Balance Sheet with computed
  retained-earnings/current-year-profit injection and a hard A=L+E check.
- **Vouchers** — manual entry with Tally keyboard parity (F4–F9, ^F8/^F9,
  F2, ^A, Esc), contra and free-form journals, books-locked-through guard.
- **Imports** — Excel via a CSV template, and Tally day-book XML with a
  persistent ledger→account/party mapping (mapped once, never asked again).
  Anything the importer cannot faithfully post lands excluded-with-reason in
  review — it never guesses with money.
- **Depreciation** — IT-Act WDV blocks (half-year rule, additions/disposals),
  fixed-asset register, generated FY journal through the one audited path.
- **Income tax** — computation of total income per entity type (slabs,
  surcharge with marginal relief, rebate, presumptive, 40(b) indicative
  ceiling), advance-tax schedule, adjustments and payments as free metadata.
- **TDS** — deduct-on-payment vouchers (register row atomically tied to the
  journal), quarterly 26Q/24Q summaries, computed-amount challan deposits.
- **Compliance** — due-date board per FY (GSTR-1/3B, TDS deposits & returns,
  advance tax, ITR) with human done/n-a marks and derived overdue.
- **CA pack** — `/pack?fy=` print-composed bundle: cover → BS → P&L →
  computation → GST 12-month summary → TDS + challans → depreciation →
  debtors/creditors annexure. Print to PDF from the browser.

**Every statutory rate and due date carries a `verified` flag and a `source`,
and the on-screen and exported caveats are driven BY those flags** — so a
verified year renders clean while an unverified one warns everywhere,
including in the printed CA pack.

- **FY 2026-27 is VERIFIED** (2026-07-21) against fetched gazette text —
  Finance Act 2026, Income-tax Act 2025, Income-tax Rules 2026. See
  `EVOLUTION.md` #19 for the protocol and what it caught.
- **FY 2025-26 is deliberately NOT verified.** It is a 1961-Act year; the
  research is done and recorded in `RVOS-003-P1-FINDINGS.md`, but no flag is
  flipped until each claim survives an independent adversarial re-check.

A figure becomes verified only by checking it against the primary text and
putting the citation in its `source` field (`src/lib/tax/india-it.ts`,
`tds.ts`, `compliance.ts`). Never flip a flag to quieten a banner. And note
EVOLUTION #21: a primary source can serve a STALE VERSION at a live URL —
pin the version and cross-check a second host.

## Tests & smoke

```bash
npm test                              # unit: tax math, schema, posting, reports
DEMO_MODE=1 npx tsx scripts/smoke.ts  # end-to-end against a fresh temp db
```

## Deferred (out of scope)

- Multi-page ledger stitching
- Official GSTN/ITD filing schemas — portal JSON, TRACES FVU (this is filing
  *prep*; the computation JSON export is the seam)
- Bill-wise receipt allocation
- Void/reverse journals (post-only; fix forward)
- RCM / TCS / composition scheme; payroll (192B amounts entered manually)
- Companies-Act depreciation, MAT, deferred tax
- 26AS/AIS reconciliation; 3CA/3CB/3CD
- Multi-client books (one company per instance)
- Hard period close (soft books-locked-through only)
- e-invoice / e-way bill
- Auth (Tailscale is the perimeter)
- Non-India tax packs (the regime interface in `src/lib/tax/regime.ts` is the seam)
- Automated backups
- Recovery UI for a document stuck in `extracting` after a server crash
  (workaround: it still accepts a re-extract once the server is back)

## Running it for real (RVOS-003)

Delivered to an accounting office on their own machine. See
**[docs/DAY-ONE.md](docs/DAY-ONE.md)** for the runbook written for the office
itself — opening balances, imports, the backup drill, and what the caveat
banners mean.

```bash
npm run preflight     # can this machine run it? Node, native module, disk, port, claude CLI
npm run start         # binds 127.0.0.1 by default
npm run backup        # SQLite online backup + integrity check + retention
npm run restore -- --list
```

- **Auth.** There is a login (RVOS-003 P2) and no default credentials — the
  first person to open the app creates the account. Sessions live in the
  database so they can be revoked; only the SHA-256 of the cookie token is
  stored, so a copied `.db` yields no usable session.
- **Bind.** `npm run start` answers on loopback only. Remote access is an
  explicit opt-in: `REVENUEOS_BIND=<tailscale ip -4>`. Binding every interface
  is refused unless `REVENUEOS_ALLOW_ANY=1`. Tailscale is defence in depth
  BEHIND the login, never the perimeter. Set `REVENUEOS_HTTPS=1` only if TLS
  is terminated in front, or the session cookie will be dropped over plain
  HTTP and login will loop.
- **Backups.** `REVENUEOS_BACKUP_DIR` should point OFF this disk. A snapshot is
  verified by re-opening it, probing the accounting tables and asserting
  journal lines balance — and the test suite performs a real restore. See
  EVOLUTION #23 for why that is not paranoia.
- **Windows install.** `install/windows/setup.ps1`, `uninstall.ps1`. Both are
  **WINDOWS-UNVERIFIED** — authored on macOS, never executed on Windows. They
  stay labelled that way until run end-to-end on the office machine.

