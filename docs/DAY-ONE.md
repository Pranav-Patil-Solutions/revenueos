# RevenueOS — day one

For the office actually using this. No development knowledge assumed. Work
through it in order; each step takes a few minutes.

If something here does not match what you see on screen, trust the screen and
tell Pranav — a wrong instruction is worse than none.

---

## 1. Start it and create your account

Double-click **`start-revenueos.bat`**, then open **http://localhost:3322**.

The first screen asks you to **create an account**. There is no default
username or password — that is deliberate. A shipped "admin / admin" that
nobody changes looks secure and isn't.

Choose a password of at least 10 characters with a letter and a number. Write
it down somewhere real. There is no password-reset e-mail: this machine has no
mail server and no cloud account behind it.

> Five wrong passwords locks the account for 15 minutes. The lock survives a
> restart, so rebooting will not clear it — waiting is the only way through.

Leave the app running. Closing the window stops it.

---

## 2. Settings

Go to **Settings** and fill in, for the business whose books these are:

| Field | Notes |
|---|---|
| Company name | Appears on every report and on the CA pack cover |
| Entity type | Proprietorship / Partnership–LLP / Private limited. **Changes the tax computation** — get it right |
| PAN, TAN, GSTIN | Leave blank if genuinely not registered; blank switches off the returns you do not owe |
| State code | Drives CGST+SGST vs IGST. Maharashtra is 27 |
| Default GST rate | The rate used when a ledger row does not say otherwise |
| Prices include GST | Tick if your ledger amounts are gross |
| Books locked through | Leave empty at first. See step 8 |

**GST rows only appear if a GSTIN is set. TDS rows only appear if a TAN is set,
or once the books already contain a deduction.** If a whole section of the
compliance board is missing, this is usually why.

---

## 3. Check the chart of accounts

**Settings → Chart of accounts.** 23 accounts are created for you. You can add
your own and rename existing ones; you cannot delete one, because a deleted
account would orphan the entries posted to it.

The ones you will use on day one:

| Code | Account |
|---|---|
| 1000 | Cash |
| 1100 | Bank |
| 1200 | Accounts Receivable (debtors) |
| 2100 | Accounts Payable (creditors) |
| 3000 | Opening Balance Equity |
| 3100 | Capital Account |

---

## 4. Enter the opening balances

> **Taking on a second client?** Each client's books are a separate
> *company* — create one from **Companies** in the top bar, then switch to
> it. A new company gets its own chart of accounts automatically (the same
> 23 accounts as step 3), but starts with zero balances of its own — do this
> step again, for that company, before posting anything else in it.

**This is the step people get wrong, so it is spelled out.**

RevenueOS starts with empty books. Before entering anything new, bring in the
closing balances from wherever the books were kept until now (Tally, a
spreadsheet, the previous accountant's file).

Go to **Vouchers → Journal** (or press **F7**) and post ONE entry dated the
first day of the financial year:

- **Debit** every asset — cash, bank, debtors, fixed assets
- **Credit** every liability — creditors, loans, taxes payable
- **Credit `3000 Opening Balance Equity`** with whatever makes the two sides
  equal

Worked example — a business starting 1 April 2026 with ₹5,000 cash,
₹1,20,000 in the bank, ₹45,000 owed by customers and ₹30,000 owed to
suppliers:

| Account | Debit | Credit |
|---|---:|---:|
| 1000 Cash | 5,000.00 | |
| 1100 Bank | 1,20,000.00 | |
| 1200 Accounts Receivable | 45,000.00 | |
| 2100 Accounts Payable | | 30,000.00 |
| **3000 Opening Balance Equity** | | **1,40,000.00** |
| | **1,70,000.00** | **1,70,000.00** |

The two totals **must** match — the app refuses an unbalanced entry rather
than saving a broken one.

Afterwards, open **Reports → Trial balance** and confirm the badge says
**Balanced**, and **Reports → Balance sheet** shows assets equal to
liabilities plus equity. In the example: assets ₹1,70,000 = liabilities
₹30,000 + equity ₹1,40,000.

> **Per-customer and per-supplier balances.** The single entry above puts a
> total into 1200/2100 but does not say *who* owes what. To get statements per
> party, post each party's opening balance as its own line with that party
> selected, or import them (step 5). Totals must still agree with the control
> accounts.

---

## 5. Bring in the existing books

**Imports** offers two routes.

**Excel** — download the template, fill it in, upload it. The columns are
fixed: date, particulars, ref_no, party, entry_type, debit, credit, gst_rate,
settle_account.

**Tally** — export a Day Book as XML from Tally and upload it. The first time,
you will be asked to map each Tally ledger name to an account or a party. That
mapping is remembered, so later imports ask nothing.

Both land in a **review screen** first. Nothing reaches the books until you
press Post.

**Rows the importer refuses to guess at** arrive unticked, with the reason
written into the description. This is deliberate — it will not invent an
entry involving money. Common reasons:

- a voucher type it does not handle (Journal, Contra, stock) → post it by hand
- a cash sale (that is a sale *and* a receipt — two entries)
- TDS, discount, freight or round-off legs it cannot place
- GST that does not reconcile exactly to a known rate
- a ledger name it has not been told about

Post what is correct, fix the rest by hand. The trial balance is the check:
if it is not zero afterwards, something was missed.

---

## 6. Daily use

- **Capture** — photograph a handwritten ledger page from a phone, review the
  extracted rows, post. Needs the Claude CLI signed in (step 9).
- **Vouchers** — type entries directly. Tally keys work: F4 contra,
  F5 payment, F6 receipt, F7 journal, F8 sale, F9 purchase, Ctrl+A to post,
  **?** for the full list.
- **Imports** — Excel and Tally, as above.

Everything posts to one set of double-entry books. **Posted entries cannot be
edited or deleted** — correct them by posting an opposite entry, the way a
manual ledger works. This is what makes the books auditable.

---

## 7. Backups — and proving they work

A nightly backup runs at 20:00 by itself.

**Do this once, now:**

```
setx REVENUEOS_BACKUP_DIR "D:\revenueos-backups"
npm run backup
```

Point it at an external drive or a synced folder. The default location is
inside the app folder, **on the same disk as the books** — that survives a
mistake, not a dead disk, a stolen machine, or ransomware.

**Then prove a backup can come back:**

```
npm run restore -- --list
```

Every snapshot is listed with a ✓ or ✗. A ✗ means that snapshot is not
usable — say so immediately.

To actually restore: **stop the app first**, then

```
npm run restore -- --latest --yes
```

The books being replaced are kept as `revenueos.db.pre-restore-…` rather than
deleted, so a wrong choice is recoverable. Start the app and check the trial
balance before entering anything new.

> A backup nobody has ever restored is a rumour. Do the drill once now, while
> nothing is wrong.

---

## 8. Locking a closed period

Once a month or a year is filed, set **Books locked through** in Settings to
the last date of that period. Entries dated on or before it are then refused.

Corrections after a lock are posted as current-dated opposite entries — never
by reopening the period.

---

## 9. Photo extraction and the Claude account

Reading ledger photographs uses the **Claude CLI signed in on this machine**,
and bills **whoever is signed in**. Sign in with the office's own account:

```
claude login
```

Check the account shown is the office's, not the installer's.

**Everything else works without it** — manual vouchers, Excel and Tally
imports, every report, and the CA pack.

---

## 10. Reaching it from another computer or phone

By default RevenueOS answers only on the machine it runs on.

To open it to the office, install Tailscale, sign in to the office tailnet,
and run `tailscale ip -4` to get this machine's address. Then edit
`start-revenueos.bat` and add above the `call` line:

```
set REVENUEOS_BIND=100.x.y.z
```

Restart it. Phone capture is then at `http://100.x.y.z:3322/capture`.

**Tailscale sits behind the login, not instead of it.** Everyone still signs
in. Serving on every network is refused on purpose — that would expose the
books on whatever Wi-Fi this machine happens to join.

---

## 11. The caveat banners on tax screens

Tax rates and due dates are marked **verified** or **unconfirmed** in the app.
Unconfirmed figures show a banner on screen and carry the same warning into
every export and the printed CA pack.

- **FY 2026-27** is verified against the published Acts.
- **FY 2025-26** is also verified now (checked 21–22 July 2026 against the
  gazette texts, group by group). It no longer shows a banner. It used to, and
  if you remember being told otherwise, that is why.

Verification is recorded **per group of fields, per year** — not one flag for a
whole year — so a computation only claims to be verified for the figures it
actually read. If a future year is added without that work being done, its
computations will show the banner again automatically.

**Do not remove a banner to make a report look tidy.** A figure becomes
verified only when someone has checked it against the Act or the official
notification and recorded the citation in the code. That is a job for Pranav,
not a setting.

Some things are deliberately not modelled and are documented rather than
guessed: the ₹400 crore turnover test for company rates, GSTR-9/9C, QRMP
filing dates, TDS on partner remuneration, and salary standard deduction.
Check those by hand.

---

## 12. When something is wrong

**It will not start** — run `npm run preflight`. It checks Node, the database
engine, folder permissions, disk space, the port and the Claude CLI, and each
failure tells you what to do.

**"Port 3322 already in use"** — it is probably already running. Look for the
window.

**Login loops back to the login page** — usually the browser refusing the
session cookie. Tell Pranav; do not work around it.

**A report looks wrong** — check the trial balance first. If it is not
balanced, an import or opening entry is incomplete. If it *is* balanced, the
books are internally consistent and the problem is a classification, not a
loss.

**Anything involving money that you cannot explain** — stop, take a backup
(`npm run backup`), and ask. Do not "fix" it with more entries.
