<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.

In this Next.js version, `params` in pages and route handlers are **Promises** and MUST be awaited (`const { id } = await params;`). Same for `searchParams`.
<!-- END:nextjs-agent-rules -->

# RevenueOS

Finance department in a box for SMBs: ledger-photo → AI extraction → human review → double-entry books → statements, trial balance, P&L, GST filing prep.

- Dev server: `npm run dev` → http://localhost:3322 (ports 3000/3311 belong to other apps — never use them).
- All money is INTEGER paise. No floats in the db or posting math.
- LLM calls shell out to the locally authenticated `claude` CLI (subscription-billed). Never use `@anthropic-ai/sdk` or `ANTHROPIC_API_KEY` — there are zero API credits.
- `DEMO_MODE=1` short-circuits extraction with a canned fixture (no subscription burn).
- DB: `data/revenueos.db` (WAL, foreign keys ON). Uploads: `data/uploads/`. Both gitignored.
