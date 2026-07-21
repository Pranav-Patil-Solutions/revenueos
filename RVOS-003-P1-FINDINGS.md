# RVOS-003 P1 — FY 2025-26 verification findings (research pass 2026-07-21)

Basis rule throughout: **FY 2025-26 = AY 2026-27**, charged under the
**Income-tax Act 1961** by Finance Act 2026 s.2(1). The Income-tax Act 2025
commences 1 Apr 2026 and governs tax year 2026-27 onward — it does NOT apply
to this year. FA 2026's First Schedule carries BOTH Part I-A (1961-Act rates
for AY 2026-27) and Part I-B (2025-Act rates); Part I-B is the wrong year here.

Research method: 4 independent agents against primary gazette text, each
required to state FY-vs-AY basis per figure. NOT yet adversarially re-checked —
do that before flipping any flag (EVOLUTION #19 protocol).

---

## 1. Individual rates — ALREADY CORRECT IN CODE, needs citation only

Every field of `TAX_YEARS["2025-26"]` in `src/lib/tax/india-it.ts` matches the
Gazette. Assembled from secondary sources, but right:

| Field | Code value | Verdict |
|---|---|---|
| `slabs_new` | 4/8/12/16/20/24L @ 0/5/10/15/20/25/30 | ✅ FA 2025 s.25 → s.115BAC(1A)(iii) |
| `slabs_old` | 2.5/5/10L @ 0/5/20/30 | ✅ FA 2026 Sch I Part I-A Para A(I) |
| `rebate_new` | ₹12L / ₹60,000 / marginal relief | ✅ FA 2025 s.20(a) |
| `rebate_old` | ₹5L / ₹12,500 / NO marginal relief | ✅ correct — cliff, no relief |
| `surcharge` | 10/15/25/37 | ✅ FA 2026 Sch I Part I-A Para F Table 1 |
| `surcharge_cap_new` | 25 | ✅ no 37% tier in new regime (FA 2026 s.2(4)(b) Sl.10) |
| `cess_rate` | 4 | ✅ FA 2026 s.2(6) |

Primary sources: FA 2025 gazette CG-DL-E-29032025-262125
(egazette.gov.in/WriteReadData/2025/262125.pdf); FA 2026 gazette
CG-DL-E-31032026-271439 (…/2026/271439.pdf).

Notes to fold into `source`:
- ₹75,000 new-regime standard deduction's authority is **Finance (No.2) Act
  2024 s.10 + Taxation Laws (Amendment) Act 2025 s.3**, NOT FA 2025. FA 2025
  moved the slabs to a new clause (iii) and the s.16(ia) proviso only named
  clause (ii); TLAA 2025 retro-patched it. Not modelled (business income) —
  documented gap, but get the authority right if it is ever modelled.
- FA 2025 s.20(b) added a SECOND proviso to s.87A capping the rebate to tax at
  s.115BAC(1A) rates. Widely read as denying rebate against special-rate gains;
  that reading is NOT primary-sourced. App carries no special-rate income →
  documented gap, do NOT implement the consensus reading on commentary alone.
- Old-regime **senior (₹3L) / super-senior (₹5L)** slabs are not modelled.
  State as a limitation; the office may have individual clients.
- New regime is the DEFAULT (s.115BAC(1A) chapeau); opt-out via s.115BAC(6).
  Form 10-IEA / Rule 21AGA is commentary-only — UNVERIFIED.

## 2. TDS — VALUES IDENTICAL ACROSS BOTH YEARS. No value axis needed.

The four sections in `src/lib/tax/tds.ts` carry the same numbers in FY 2025-26
and FY 2026-27, each independently primary-verified against a DIFFERENT gazette:

| Section | Rate | Threshold | FY 25-26 authority | FY 26-27 authority (already in code) |
|---|---|---|---|---|
| 194C | 1% indiv/HUF, 2% other | ₹30,000 single + ₹1,00,000 aggregate | FA 2025 (unamended; ₹30k from 1-7-2010, ₹1L from 1-6-2016) | ITA 2025 s.393(1) Sl.6(i) |
| 194J | 10% prof, 2% technical/call-centre | ₹50,000 | FA 2025 s.65, w.e.f. **1-4-2025** | ITA 2025 s.393(1) Sl.6(iii) |
| 194I | 10% land/bldg/furniture, 2% P&M | ₹50,000 **per month or part** | FA 2025 s.64, w.e.f. **1-4-2025** | ITA 2025 s.393(1) Sl.2(ii) |
| 194H | 2% | ₹20,000 | FA 2025 s.63, w.e.f. **1-4-2025** | ITA 2025 s.393(1) |
| 192 (192B) | average rate, no threshold | — | s.192(1), unamended since 1968; bridge s.2(37A)(i) | s.392 |
| 206AA | higher of specified rate or **20%** — a FLOOR | — | unamended by FA 2025 | (ITA 2025 equivalent unlocated) |

**Correction to my earlier R2 risk assessment: a per-year VALUE axis is NOT
required.** EVOLUTION #19's two "corrections" (194J ₹30k→₹50k, 194I annual→
per-month) were in fact FA 2025 changes effective **1 Apr 2025** — i.e. they
were already the FY 2025-26 values. The app landed on the right numbers.

What IS wrong: `tds.ts` cites **only** the ITA 2025 s.393 authority and marks
`verified: true` unconditionally. Rendered on an FY 2025-26 screen, that cites
an Act that did not govern the year. → needs a per-year **authority/citation**
axis, not a value axis. Much cheaper than feared.

- **206AB is repealed w.e.f. 1 Apr 2025** (FA 2025 s.71) — inoperative for the
  whole of FY 2025-26 and absent from ITA 2025. Not modelled; nothing to do.
- 194J's ₹50,000 is **per category** — four independent limbs (professional /
  technical / royalty / s.28(va)), not one shared pool. The code's note says
  "per tax year" without this. Improve the note.
- Director's remuneration under 194J(ba) has **NO** threshold.

## 3. Compliance due dates — DATES RIGHT, AUTHORITIES WRONG FOR THIS YEAR

`src/lib/compliance.ts` RULES all cite ITA 2025 / Income-tax Rules 2026 and
ship `verified: true`, but `dueItems()` renders them for EVERY FY. On an
FY 2025-26 board the citations are to law that did not govern the year.

| Rule | Code cites | FY 2025-26 authority |
|---|---|---|
| `tds-deposit` (:62) | Rules 2026 r.218(2), "in force 1 Apr 2026" | **Rule 30(2)** of the 1962 Rules (7th; **March → 30 April**) |
| `tds-return` (:68) | Rules 2026 r.219(4), "Form 140 / Form 138" | **Rule 31A(2)**, forms **26Q / 24Q** (correct for all 4 quarters incl. Q4 filed 31 May 2026) |
| `advance-tax` (:80) | ITA 2025 s.408 | **s.211** — 15/45/75/100%; presumptive (44AD/44ADA) = whole amount by 15 Mar, s.211(1)(b) |
| `itr` (:89) | ITA 2025 s.263(1) | **s.139(1) Expln 2**, as substituted by **FA 2026 s.5** |
| `gstr1` / `gstr3b` | GST portal, 11th / 20th | ✅ same both years (Notn 83/2020-CT; Rule 61(1)(i)) |

Internal contradiction: `compliance.ts:191` renders detail `"26Q/24Q statement"`
while the rule note at :68 says Form 140/138.

### 3a. ITR tiers — **closes HANDOFF open item #2**
FA 2026 s.5 substituted Explanation 2 to s.139(1) of the **1961** Act
**w.e.f. 1 March 2026**, so it bites for AY 2026-27 = FY 2025-26:

| Sl | Class | Due |
|---|---|---|
| 1 | s.92E (transfer pricing) applies | 30 Nov 2026 |
| 2 | Company; accounts requiring audit; partner of audited firm | 31 Oct 2026 |
| 3 | **Income from business/profession, accounts NOT audited**; partner of non-audited firm | **31 Aug 2026** |
| 4 | Any other assessee | 31 Jul 2026 |

`itrItem()` at `compliance.ts:232` gates the 31 Aug tier on
`entityType === "proprietorship" && y >= 2026`. **Wrong on both axes:**
- `y >= 2026` excludes FY 2025-26, where the tier now applies.
- The statutory discriminator is "business/profession income, not audited" —
  which covers a **non-audited firm**, not proprietorships only. HANDOFF open
  item #2 (partnership ITR-5 / 31 Aug) is therefore RESOLVED: a non-audited
  firm gets 31 Aug.

Current behaviour fails SAFE (shows the earlier 31 Jul), so this is a
correctness upgrade, not a live mis-filing risk.

### 3b. Not modelled — now with dates
- **GSTR-9 / 9C for FY 2025-26 → 31 Dec 2026** (s.44(1) CGST r/w Rule 80(1)).
  GSTR-9 optional ≤ ₹2 cr turnover; 9C mandatory > ₹5 cr, self-certified.
  ⚠ The ₹2 cr exemption rests on Notn 15/2025-CT, **primary copy unreachable**
  (CBIC index 404). Ship `verified: false`; treat 9 as required unless clearly
  under ₹2 cr.
- **Tax-audit report (3CA/3CB-3CD) → 30 Sep 2026** (s.44AB, "one month prior").
  ⚠ IndiaCode's s.44AB consolidation is stale to 2017 and lacks the FA 2020
  "one month prior" substitution; confirmed only via CBDT/e-filing material.
  Use 30 Sep as the safe date. Out of scope currently (3CD deferred).
- **GSTR-3B under QRMP is state-dependent: 22nd vs 24th** (Rule 61(1)(ii)
  Table). QRMP not modelled; if it ever is, it MUST branch on the
  registration's principal place of business or it is wrong for ~half of India.

### 3c. ITR extension check — none found, not conclusive
No CBDT extension for AY 2026-27 in the e-filing news feed through 20 Jul 2026.
BUT `incometaxindia.gov.in` (the authoritative circulars index) **403s all
automated access**, so a very recent circular cannot be excluded. Precedent:
AY 2025-26 was extended 31 Jul → 15 Sep → 16 Sep by Circular 6/2025.
**31 July 2026 stands as operative-and-safe. Re-check manually before relying.**

## 4. Advance tax — presumptive single instalment applies to THIS year too
s.211(1)(b): a 44AD/44ADA assessee pays the whole amount by **15 Mar**. The app
gained this for 2026-27 (ITA 2025 s.408(2)); the 1961-Act equivalent means
FY 2025-26 needs the same collapse. Check `dueItems()` — the advance-tax loop
at :198-210 emits four instalments unconditionally; the presumptive branch is
applied elsewhere (verify) and must cover this year.
⚠ 15 Jun 2025 and 15 Mar 2026 both fell on a **Sunday**. Circular 676 (next
working day) is NOT primary-verified — do not build working-day slack into any
234B/234C interest computation.

## 5. Entity rates / advance tax — partial

Confirmed HIGH (current text via proxy, cross-checked against India Code
`indiacode.nic.in/handle/123456789/2435`):
- **s.211 normal** — 15/45/75/100% by 15 Jun / 15 Sep / 15 Dec / 15 Mar, each
  reduced by earlier instalments. Stated on an **FY** basis — no AY trap.
  ✅ matches `advance_tax` in code.
- **s.211 presumptive** — 44AD/44ADA pay the whole amount in ONE instalment by
  15 Mar. Proviso: anything paid by 31 Mar still counts as advance tax.
- **s.234B** — 1%/month simple, from 1 April following the FY, on assessed tax
  or the shortfall below 90%.
- **s.234C** — 1%/month **for three months** on Jun/Sep/Dec shortfalls;
  **one-time 1%** on the March shortfall. Safe harbour: no interest if ≥12%
  paid by 15 Jun or ≥36% by 15 Sep. Presumptive: tested ONCE at 15 Mar,
  one-time 1% (NOT ×3).
- Finance Act 2025 amends **none** of s.211 / s.234B / s.234C (full-text
  gazette grep). Last: s.211 & s.234C by Act 7 of 2017; s.234B by Act 20 of 2015.
- **Cutover reconfirmed from a second angle**: ITA 2025 (Act 30 of 2025, assent
  21 Aug 2025, egazette 265620.pdf) cl.1(3) — "shall come into force on the
  1st April, 2026." FY 2025-26 stays under the 1961 Act.

**Correction to this spec's own premise:** the s.40(b) revision was **Finance
(No.2) Act 2024**, NOT Finance Act 2025. The limits do apply to FY 2025-26;
only the attribution was wrong. This is the SECOND premise in my brief that was
wrong (see §2's R2 correction). Do not let a brief's framing survive into a
`source` field unchecked.

### Itemized entity values vs code (FA 2026 Sch.1 Part I-A unless noted)

| Code field | Code value | Verdict |
|---|---|---|
| `firm_rate` | 30% | ✅ Part I-A Para C |
| `firm_surcharge` | 12% > ₹1cr | ✅ Para F Table 1 Sl.4 (marginal relief Table 2 Sl.4) |
| `company_rate` | 25% | ⚠️ **PARTIAL — see 5d** |
| `company_concessional_rate` | 22% | ✅ s.115BAA (live for AY 2026-27) |
| `company_surcharge` | 7% >₹1cr, 12% >₹10cr | ✅ Para F Table 1 Sl.5 |
| `company_concessional_surcharge` | 10% flat | ✅ overrides the 7/12 tiers for 115BAA/BAB electors |
| `partner_remuneration` | first ₹6L @ 90% or ₹3L whichever higher, then 60% | ✅ Finance (No.2) Act 2024 §14 (egazette 2024/256436.pdf), w.e.f. AY 2025-26 "and subsequent years" — so fully in force for FY 2025-26 |
| `advance_tax` | 15/45/75/100 | ✅ for normal assessees; presumptive needs the single-instalment collapse |
| `presumptive_business_rate` 8% | — | ⚠️ **CANNOT CONFIRM** (see 5a) |
| `presumptive_business_digital_rate` 6% | — | ⚠️ **CANNOT CONFIRM** |
| `presumptive_profession_rate` 50% | — | ⚠️ **CANNOT CONFIRM** |

LLP is taxed as a firm (s.2(23); FA 2026 s.2(7)(c)). Cess 4% on tax+surcharge
for all persons.

Presumptive values as best-read but **UNVERIFIED** (carry `verified: false`):
44AD ceiling ₹2cr, higher ₹3cr where cash receipts ≤5%; deemed 8% / 6% digital.
44ADA ceiling ₹50L, higher ₹75L where cash ≤5%; deemed 50%.
44AE ₹1,000/ton/month heavy (GVW >12,000kg), ₹7,500/month other, max 10 vehicles.

### ⚠ 5d. `company_rate` — a real correctness gap, not just a citation gap
The 25% rate applies ONLY where turnover/gross receipts **in PY 2023-24**
≤ ₹400 crore; otherwise the residual rate is **30%**. `india-it.ts:107-109`
already documents that the app "does not model the turnover test and always
uses 25%" — so this is a KNOWN gap, but it now has a number attached: it
silently **under-taxes every company above ₹400 crore turnover**.

Two guards if this is ever implemented:
- The measurement year is **two years prior** and the statute names PY 2023-24
  expressly for AY 2026-27. Do NOT derive it as "current year minus 1".
  (FA 2025 **Part I** says PY 2022-23 — that is AY 2025-26, the wrong year.
  Same Part I/Part III trap as §1.)
- **s.115BAB (15%) is closed to new entrants** — production had to commence by
  31 Mar 2024. If the UI ever lets a user newly elect 115BAB for FY 2025-26,
  that produces an invalid return. Currently not modelled, which is safe.

Low priority for THIS client (a small office's clients are unlikely to be
₹400cr companies) but it must be a stated limitation, not silence.

### ⚠ 5a. VERIFICATION GRANULARITY — a structural problem for P1
The research verified SOME fields of the year and explicitly refused others:
**44AD / 44ADA / 44AE (`presumptive_business_rate`,
`presumptive_business_digital_rate`, `presumptive_profession_rate`) came from
search snippets and must stay `verified: false`.**

But `TaxYearRates.verified` is ONE boolean covering ~15 fields. Flipping
`2025-26` to `true` would silently claim verification for the presumptive
rates, which nobody checked — the precise failure EVOLUTION #19 exists to
prevent, in a new shape. The same defect already exists in `tds.ts` and
`compliance.ts` (§2, §3), where one flag covers a whole rule and the citation
is year-blind.

→ P1 is NOT "flip a boolean". It needs verification metadata at the granularity
at which verification actually happens: per FIELD-GROUP and per YEAR. Spec this
before touching data.

### ⚠ 5b. Standing hazard — the ITD serves OBSOLETE section text
`incometaxindia.gov.in` hosts multiple versions of a section at plausible,
near-identical URLs, and the **obsolete lower-numbered slugs rank HIGHER in
generic search**. The agent initially cited `/w/section-211-33` (pre-1988
three-instalment scheme) and `/w/section-234c-26` (pre-1994: 20%/50%
thresholds, 1.5% rate) before catching itself — the bogus 1.5% s.234C figure
came from exactly this. Correct slugs: **`/w/section-211-64`**,
**`/w/section-234c-34`**.
EVOLUTION-worthy: "use a primary source" is not enough — a primary source can
serve a stale VERSION at a live URL. Pin exact slugs/version ids and
cross-check every retrieved section against a second host (India Code).

### Method caveat on §5
These pages were NOT fetched directly (incometaxindia.gov.in 403s everything);
they came via an `r.jina.ai` text-rendering proxy, cross-verified against India
Code. One step removed from a direct primary read — a manual browser
spot-check still has value before flipping flags.

## 5c. STILL OPEN
- **Adversarial re-check has NOT been run.** Nothing above may be flipped to
  `verified: true` until each claim is independently re-checked per
  EVOLUTION #19.
- Itemized entity/presumptive values outstanding (see §5).

## 6. Sources that blocked verification (carry into every caveat)
- `incometaxindia.gov.in` — HTTP 403 to all automated access. Blocks CBDT
  circulars, the tax calendar, and consolidated section text.
- CBIC English GST notification index — 404 (site restructure);
  `taxinformation.cbic.gov.in` API 401. GST Council listing stale at 11/2025.
- IndiaCode — redirect loops; its 1961-Act consolidation is stale to ~2017-2019.
Anything resting on these stays `verified: false`. That is the honest output.
