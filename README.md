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

## Tests & smoke

```bash
npm test                              # unit: tax math, schema, posting, reports
DEMO_MODE=1 npx tsx scripts/smoke.ts  # end-to-end against a fresh temp db
```

## Deferred (out of scope for v1)

- Multi-page ledger stitching
- Official GSTN JSON/CSV schemas (this is filing *prep* for you/your CA)
- Bill-wise receipt allocation
- Void/reverse journals (post-only; fix forward)
- RCM / TDS / TCS / composition scheme
- Income-tax estimator
- Auth (Tailscale is the perimeter)
- Non-India tax packs (the regime interface in `src/lib/tax/regime.ts` is the seam)
- Automated backups
- Recovery UI for a document stuck in `extracting` after a server crash
  (workaround: it still accepts a re-extract once the server is back)
