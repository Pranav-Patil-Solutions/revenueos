# RVOS-005 — Overview dashboard: trend, pipeline census, ⌃K · Build Spec
# Owner: Pranav · Repo: ~/revenueos · Branch: feat/rvos-005-dashboard-ux
# Ports: dev 3322 ONLY · DEMO_MODE=1 for all tests/smoke
# Status: BUILT — ship gate below

## PRODUCT
The Overview page showed four figures and a list. It answered "what are the
numbers right now" and nothing else: not whether receivables are climbing or
being collected, not where the captured pages are stuck, and not how to get to
a screen without walking the sidebar.

This build adds the two questions the figures cannot answer on their own, and
one navigation affordance. It is additive to the approved visual system — the
"Accountant Edition Light" tokens (globals.css, approved final 2026-07-19) are
NOT touched. No page outside `/` changes appearance.

## SCOPE
1. **Receivables trend** — AR closing balance at each of the last 4 month ends,
   with a hover readout. A trajectory, which no tile can express.
2. **Document status** — the capture pipeline as a census (posted / needs
   review / uploaded / …), donut plus legend, cross-highlighting on hover.
3. **⌃K command palette** — subsequence search over every route ("tb" finds
   Trial balance), arrow keys, Enter to go, Esc to close.

## OUT OF SCOPE — deliberate
- **A mobile layout.** Every page overflows ~425px below 1180px and always
  has; the delivery target is an office Windows machine (RVOS-003). Adding
  responsive layout is a design decision for its own build, not a bug fix
  smuggled into this one.
- **Re-skinning to the reference mockup.** The mockup that prompted this work
  used a different palette (blue #2E6FF2, pastel gradient tiles, 20px radii).
  Adopting it would re-colour ~22 pages including the printed CA pack and the
  tax caveat tints. Rejected: the approved token system wins.
- **Decoration.** A count-up on every figure, a staggered entrance animation, a
  quick-actions card duplicating the sidebar, and an insights rail restating
  the tiles and the donut legend were all built, then cut. On a screen the
  office opens dozens of times a day, motion that delays the figure and panels
  that restate a fact already on screen are a cost (EVOLUTION #26).

## INVARIANTS (violating any = blocker)
Inherited and still binding:
- All money INTEGER paise. The read models are SELECT-only; this build posts
  nothing and must not be able to.
- Date-only values use pure string math (`fy.ts` convention). `stepMonth` in
  reports.ts follows it — no Date arithmetic.
- Next 16: `params`/`searchParams`/`cookies()` are Promises — await them.
- Every page guards itself with `requireSession()`.
- The tenancy ratchet (test/tenancy-ratchet.test.ts) may only ever SHRINK.

New to this build:
- **A read model must tie to the control account it reports.** `receivablesTrend`
  is a running BALANCE off account 1200 — the same account `dashboardStats`
  reads — so the series ties at every point rather than being a parallel
  computation that can drift. Where it can legitimately differ from the tile
  (future-dated entries), the UI states its basis rather than hiding it.
- **A modal makes the global key layer inert.** The Tally layer decides from
  the ROUTE, so any overlay inherits it. `actionSurvivesModal` states which
  actions survive; adding a modal is a change to the KEY LAYER, not just the
  view (EVOLUTION #26).
- **A chart over a signed accounting figure scales across zero.** Never assume
  the quantity cannot go negative — a net credit on AR is an ordinary position.

## FILES
`src/lib/reports.ts` (receivablesTrend, documentStatusBreakdown, stepMonth) ·
`src/lib/keymap.ts` (^K, actionSurvivesModal) ·
`src/components/{trend-chart,donut-chart,command-palette}.tsx` (new) ·
`src/components/{shortcuts,stat-tile}.tsx` · `src/app/page.tsx` ·
`src/app/globals.css` · `test/{reports,keymap}.test.ts` · EVOLUTION.md

## SHIP GATE
- `npx tsc --noEmit` (covers test/, which `next build` does not) · `npm run lint`
  · `npm test` · `npm run build` · `npm run smoke`
- Zero-context code review of the full diff — money-adjacent, so mandatory.
- Re-review of every fix written to clear a review finding (EVOLUTION #15).
- qa-runner over the changed modules.
- Driven in a real browser on seeded throwaway books, never `data/revenueos.db`:
  the ⌃A-in-palette-over-a-valid-voucher case must leave the journal count
  unchanged, and ⌃A must still post once the palette closes.
