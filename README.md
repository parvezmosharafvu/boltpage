# Boltpage

Payment links that settle over Lightning. Approved users create a link, payers pick a USD amount
(default $10–$1,000), get a 1-hour invoice with a QR code and an **Open in Cash App** deeplink, and the page
flips to *Payment received* within seconds. Users see daily 19:00 (Asia/Dhaka) statements, their derived
balance and withdrawals; admins approve accounts, set per-user commission, process withdrawals and watch the node.

"Boltpage" is a working brand name. See docs/ARCHITECTURE.md → Assumptions to rename it.

## Stack
- `public/`: static HTML + vanilla ES modules, English/Bangla, served by a Cloudflare static-assets Worker.
- `worker/`: link-preview Worker (OG HTML for crawlers, cached per-link PNGs).
- `supabase/`: Postgres schema/RLS/RPCs (`migrations/`), Deno edge functions (`functions/`), pg_cron.
- The operator's own LND node over REST through a Cloudflare Tunnel + Access service token, using an
  invoice-only macaroon.

## Quick start (no accounts needed)
```bash
npm ci
npm run dev:mock          # http://localhost:8787 with a fake Supabase + fake invoices
```
Open `/demo` to pay (then `curl -X POST localhost:8787/__mock/control -d '{"status":"settled"}' -H 'content-type: application/json'`),
or log in as `seller@demo.test` / `admin@demo.test` with password `demo-password` (mock-only test users).

## Tests
```bash
npm test                  # public-copy check + Node unit tests + migrations & SQL tests (PGlite)
npm run test:deno         # edge functions against a mocked LND   (needs deno, or: npx deno ...)
npm run check:deno        # deno type-check of every function
npm run test:e2e          # Playwright checkout tests (npx playwright install chromium, or PW_CHANNEL=msedge)
DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres npm run test:sql && npm run test:db
                          # real Postgres + two-connection concurrency tests (what CI runs)
```
`npm run test:sql -- --update-allowlist` rewrites `ci/function_allowlist.txt`; review that diff carefully.

## Local Supabase
```bash
supabase start
supabase db reset                          # migrations + supabase/seed.sql (adds localhost as a domain)
supabase functions serve --env-file .env   # placeholders in .env.example
SUPABASE_URL=http://127.0.0.1:54321 SUPABASE_ANON_KEY=<local anon key> npm run config
npx wrangler dev                           # static site on :8787
```
Then promote yourself to admin (docs/GO-LIVE.md §4) and approve your test user.

## Docs
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): flows, security model, assumptions, milestone and acceptance-test map
- [docs/SECRETS.md](docs/SECRETS.md): every variable, where it lives, rotation
- [docs/RUNBOOK.md](docs/RUNBOOK.md): incidents, domains, deploys
- [docs/GO-LIVE.md](docs/GO-LIVE.md): node, macaroon, tunnel, Telegram, $10 test, launch

## Repository rules
- Migrations are append-only. Add `supabase/migrations/00NN_*.sql`; never edit one that has been applied.
- New RPCs are not callable by `anon`/`authenticated` until a migration grants them; CI fails if the grant
  list and `ci/function_allowlist.txt` disagree.
- Public pages must pass `npm run check:copy` (no payout-rail names; "Cash App" only as the button label).
- Secrets never go in git or `public/` (see docs/SECRETS.md).
