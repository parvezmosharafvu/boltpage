# Architecture

```
 payer browser ──► Cloudflare: preview Worker (route) ──► static-assets Worker (public/)
       │                 │ crawler UA → OG HTML + /og/*.png (cached 1 y, versioned)
       │                 └──► Supabase og-image function
       │
       ├──► Supabase REST  rpc/public_link_by_slug, rpc/public_checkout_config   (anon allowlist)
       └──► Supabase Functions  create-invoice, payment-status                   (public, rate-limited)
                                   │
                                   └──► Cloudflare Tunnel + Access service token ──► operator's LND REST
 pg_cron ──► lnd-watcher (1 min) · telegram-notify (1 min) · health (5 min) · daily settlement (13:05 UTC, SQL)
 Telegram ──► telegram-webhook (secret header) ; telegram-notify ──► Telegram Bot API
```

## Components

| Layer | Where | Notes |
|---|---|---|
| Static site | `public/`, `wrangler.jsonc` | Vanilla HTML/JS modules, no build. Extensionless HTML (`html_handling: auto-trailing-slash`); unknown paths serve `404.html`, which resolves `/<slug>` and `/pay/<slug>` in `pay.js`. |
| Preview Worker | `worker/` | Route on every site hostname. Crawlers get OG HTML; `/og/<slug>.v<ver>t<tpl>.png` proxies `og-image` with a 1-year cache. Everyone else passes through to the static Worker. |
| Database | `supabase/migrations/` | Postgres + RLS. Every write is a `SECURITY DEFINER` RPC with `search_path = ''`. Default privileges deny `EXECUTE` and table access to `anon`/`authenticated`; each migration grants exactly what it needs. |
| Functions | `supabase/functions/` | Deno, 12 functions. Each has `handler.ts` (pure, dependency-injected, unit tested) and `index.ts` (wiring). Invoice creation is shared in `_shared/invoice.ts`. |
| Lightning | operator's LND | REST via Cloudflare Tunnel, protected by Access service-token headers; invoice-only macaroon. |

## Request flows

**Checkout.** `pay.js` → `rpc/public_link_by_slug(slug, location.hostname)` returns only public fields
(name, note, effective min/max, chips, `og_version`, `checkout_enabled`) and nothing when the link,
owner or hostname is inactive. On Continue, `create-invoice`:
1. parses the amount into integer cents (≤ 2 decimals), hashes the client IP with `IP_HASH_SALT`, rate-limits per IP and per link (`rate_limit_hit`, fixed one-minute windows);
2. `prepare_checkout` (SQL) re-validates: checkout enabled, link active, owner active, domain active, amount within `max(global min, link min)`..`min(global max, link max)`;
3. converts USD→sats with integer math at the cached BTC/USD rate;
4. `POST /v1/invoices {value, memo, expiry:"3600", private:false}`;
5. `record_invoice` stamps `commission_pct`, `commission_usd = round(gross·pct/100, 2)`, `net_usd`, rate, hash, bolt11, `expires_at = now()+min(expiry,3600)`.

The page renders the QR (uppercase `LIGHTNING:` URI, alphanumeric mode), the deeplink
`https://cash.app/launch/lightning/<encoded bolt11>` and `lightning:<bolt11>`, and polls
`payment-status?id=` every 3 s (10 s while hidden, immediately on focus) until `settled|expired|failed`.

**Settlement detection.** `lnd-watcher` (cron, every minute) and `payment-status` (on demand, at most
every 4 s per payment) both call `GET /v1/invoice/<hash>` and apply `decideTransition`:
`SETTLED → settle`, `CANCELED → expire`, still `OPEN` 2 minutes past expiry → expire, unknown to LND
after expiry → fail. Transitions are SQL `UPDATE … WHERE status IN (…)`, so concurrent callers win
exactly once; the Telegram message is enqueued inside the same statement path, keyed by a unique
`dedupe_key`. A late `SETTLED` for an invoice we had marked expired is still credited (the money arrived).

**Balance.** Never stored: `user_balances` (security-invoker view) =
`Σ net_usd of settled payments − Σ amount_usd of withdrawals not rejected`.

**Withdrawals.** `request_withdrawal` locks the caller's `profiles` row (`FOR UPDATE`), re-checks status,
minimum, "one open request" and balance, snapshots the destination, optionally auto-approves under a
threshold, and notifies admins. A partial unique index enforces one open request per user as a second
line of defence. Admins move `requested → approved → paid` (reference required) or `→ rejected`
(reason required); a rejection releases the hold automatically because of how the balance is derived.

**Daily statements.** Cycle *D* runs from (D−1) 19:00 to D 19:00 Asia/Dhaka (13:00 UTC; computed with
`AT TIME ZONE 'Asia/Dhaka'`). `generate_daily_invoices(D)` upserts one row per user with settled payments,
idempotent on `(user_id, cycle_date)`, keeps `paid_out`, and sends one "statement ready" message per
closed statement. pg_cron runs it at 13:05 UTC for D and D−1 (absorbs late settlements). Admin "Run now"
calls the same function through `admin_run_daily_settlement` (audited). The dashboard shows the live
current cycle computed on the fly plus stored history.

**Telegram.** `create_telegram_link_code` stores a 24-hex one-time code valid 15 minutes and returns
`https://t.me/<bot>?start=<code>`. The webhook (secret header, fails closed) calls `telegram_link_chat`
(`linked|expired|invalid`); `/stop` unlinks. Notifications go through `notification_outbox`; recipients and
the user's preferences are resolved at enqueue time; `telegram-notify` claims with `FOR UPDATE SKIP LOCKED`,
retries transient errors up to 5 times and fails permanent ones immediately.

**Admin-issued invoices.** Admin → Invoices → *Create invoice* calls `admin-actions` (`create_invoice`),
which runs the same `issueInvoice()` path as checkout (`_shared/invoice.ts`: SQL validation, limits,
`checkout_enabled`, rate, LND, commission stamp) and stores a payer `memo` and `issued_by`. The admin gets
`https://<domain>/<slug>?i=<payment id>`; the checkout reads it through the public `invoice` function, which
returns the BOLT11 only while the invoice is pending, and opens straight to the QR. *Cancel* calls LND
`POST /v2/invoices/cancel`, then looks the invoice up: `CANCELED` → expired, `SETTLED` → credited, still
`OPEN` → error (nothing is marked expired that could still be paid). Both actions are audited.

**Reports and overview.** `my_report(month)` (Dhaka calendar month) gives the user totals, attempts by
status (success rate = paid ÷ paid+expired+failed), daily earnings by cycle, top links and recent paid
payments. `admin_overview()` gives revenue incl. commission (today = current cycle, month, all time),
commission, *payable* (settled net − withdrawals already paid), open withdrawals, users, links, outstanding
statements and invoices, a 30-cycle chart and top users.

**Statements management.** `admin_create_statement(user, cycle)` builds one user's statement (even with zero
payments); `admin_update_statement` moves `closed → paid_out` (payout reference required) or
`paid_out → closed` (reason required) and adds notes. Amounts are always recomputed from payments, never typed.

**Payment methods.** Edited in their own admin tab (structured editor over `app_settings.payout_methods`).
A method can be disabled (`"enabled": false`): it disappears from `my_app_config`, new destinations and
withdrawals refuse it, saved destinations stay intact.

**Two-factor.** Users (admins especially) enroll TOTP in Dashboard → Settings (`auth.mfa.enroll` +
`challengeAndVerify`). Any session whose user has a verified factor is asked for the code after login and
before the dashboard/admin load. `admin_require_mfa` makes every admin RPC demand an aal2 session; a trigger on
`app_settings` refuses to switch it on from an admin session that is not aal2, so an admin cannot lock
themselves out. Admins can also create users directly (`create_user`: service-role `auth.admin.createUser`,
optional immediate activation and commission; with no password the user gets a set-password email sent to
an active site domain only).

**Multi-domain.** `site_domains` lists hostnames. Links only resolve when the request hostname is active
(checkout and crawlers both pass it). The dashboard shows each link on every active domain.

## Security model

- RLS on every table. Users read only their own rows **and only while active**; admins read everything.
  `anon` has no table privileges at all; it can execute exactly `public_link_by_slug` and
  `public_checkout_config` (see `ci/function_allowlist.txt`, enforced by `npm run test:sql`).
- `authenticated` cannot `INSERT/DELETE` anywhere and can `UPDATE` only `profiles`, where the
  `profiles_guard` trigger rejects changes to `role`, `account_status`, `commission_pct`,
  `telegram_chat_id`, link codes, email and timestamps.
- Signup metadata cannot set role or status: `_handle_new_user` copies only name/phone/Telegram username.
- `is_admin()` = role admin + active + (`aal2` session when `admin_require_mfa` is on). Every admin RPC
  checks it and writes `audit_log` with before/after.
- Service-role, macaroon, Access secret, bot token, webhook secret and cron secret exist only as function
  secrets / Vault entries. `scripts/write-config.mjs` refuses to put a service-role key in `public/config.js`.
- CSP `script-src 'self'` (libraries are vendored in `public/vendor/`), `frame-ancestors 'none'`,
  HSTS, nosniff, strict referrer. All user text is inserted with `textContent` (DOM builder `h()`); the
  preview Worker HTML-escapes every value; the OG renderer draws glyphs (no markup).

## Assumptions

- **Exchange rate.** BTC/USD = median of the Coinbase spot, Kraken and Bitstamp public tickers
  (whichever answer within 4 s, values outside 1k–10M rejected), cached ≤ 60 s in memory and in
  `fx_rates` so all isolates share one rate. The rate used is stored on every payment. No API keys needed.
  If every source fails, checkout returns `rate_unavailable` instead of guessing.
- **Statements** are generated only for users who had settled payments in the cycle (no zero rows).
- **Expiry.** We trust LND to cancel expired invoices and add a 2-minute grace before expiring an invoice
  that still reads `OPEN`, to avoid racing a last-second payment.
- **Admin panel strings** are English (the `t()` fallback); every user-facing string is bilingual.
- **OG images** use satori's default font; names in scripts it lacks (e.g. Bangla) may render as boxes.
  Add a Noto font to `og-image` if that matters for your users.
- **Brand.** "Boltpage" is a working name. Rename by changing `BRAND_NAME` (config, Worker var, function
  env) and the literal in HTML titles/headers (`grep -r Boltpage public worker`), then `npm run og:render`.

## Milestone map

| Milestone | Main files | Tests |
|---|---|---|
| M0 scaffold | `wrangler.jsonc`, `supabase/config.toml`, `.github/workflows/verify.yml`, `.env.example`, `docs/SECRETS.md` | CI itself |
| M1 schema + RLS | `0001_init.sql`, `0002_core.sql` | `ci/sql/01_schema.sql`, `02_*`, allowlist |
| M2 auth & approval | `0002_core.sql`, `0007_admin.sql`, `public/{register,login,reset}.html`, `auth.js` | `ci/sql/02_auth_approval.sql` |
| M3 links | `0003_links_profiles.sql`, `dashboard.js` (links) | `ci/sql/03_links_checkout.sql`, `tests/unit/core.test.mjs` |
| M4 LND + invoices | `_shared/{lnd,rate,money,settle}.ts`, `create-invoice`, `payment-status`, `lnd-watcher`, `0004_payments.sql` | `supabase/functions/tests/*`, `ci/sql/04_payments.sql`, `tests/db/` |
| M5 checkout UX | `404.html`, `pay.js`, `core.js` | `tests/e2e/checkout.spec.mjs` |
| M6 commission & balance | `0004_payments.sql` (`record_invoice`, `user_balances`) | `ci/sql/04_payments.sql` |
| M7 daily settlement | `0005_settlement.sql`, `0009_cron.sql`, `daily-settlement` | `ci/sql/05_settlement.sql` |
| M8 dashboard | `dashboard.html/js`, `ui.js` | e2e via mock server (manual walkthrough) |
| M9 withdrawals | `0006_withdrawals.sql`, `user-withdraw` | `ci/sql/06_withdrawals.sql`, `tests/db/concurrency.test.mjs` |
| M10 admin | `0007_admin.sql`, `admin.html/js`, `admin-actions`, `node-status` | `ci/sql/08_admin.sql`, `misc_test.ts` |
| M11 Telegram | `0008_telegram.sql`, `telegram-webhook`, `telegram-notify` | `ci/sql/07_telegram.sql`, `telegram_test.ts` |
| M12 multi-domain + OG | `site_domains`, `worker/`, `og-image`, `scripts/render-og.mjs` | `tests/unit/og-worker.test.mjs`, `03_links_checkout.sql` |
| M13 hardening | `public/_headers`, `ci/check_public_copy.mjs`, `.gitleaks.toml`, `docs/GO-LIVE.md` | `tests/unit/public-copy.test.mjs`, gitleaks job |
| M14 reference parity | `0010_reports_invoices_mfa.sql`, `_shared/invoice.ts`, `invoice`, `admin-actions` (invoices, users), `admin.js` (overview, invoices, payment methods, create user), `dashboard.js` (reports, two-factor), `auth.js` (code step, password toggle) | `ci/sql/09_reports_invoices_mfa.sql`, `admin_invoice_test.ts`, `tests/e2e/app.spec.mjs` |

## Acceptance tests → where they run

| # | Covered by |
|---|---|
| 1 | `npm run test:sql` (fresh DB, all migrations, `ci/sql/*`) |
| 2 | `ci/sql/02_auth_approval.sql` |
| 3 | `ci/sql/02_auth_approval.sql` (profile guard) |
| 4 | `ci/sql/03_links_checkout.sql`, `create_invoice_test.ts`, `core.test.mjs`, `checkout.spec.mjs` |
| 5 | `create_invoice_test.ts`, `lnd_test.ts`, `ci/sql/04_payments.sql` |
| 6 | `checkout.spec.mjs` |
| 7 | `watcher_status_test.ts`, `ci/sql/04_payments.sql`, `tests/db/concurrency.test.mjs` |
| 8 | `ci/sql/04_payments.sql`, `money_rate_test.ts` |
| 9 | `ci/sql/05_settlement.sql` |
| 10 | `ci/sql/06_withdrawals.sql`, `tests/db/concurrency.test.mjs` |
| 11 | `telegram_test.ts`, `ci/sql/07_telegram.sql` |
| 12 | `ci/sql/03_links_checkout.sql`, `og-worker.test.mjs`, `checkout.spec.mjs` |
| 13 | `ci/run-sql-tests.mjs` privilege checks + `ci/function_allowlist.txt` |
| 14 | `ci/check_public_copy.mjs`, `public-copy.test.mjs` |
| 15 | gitleaks job, `check_public_copy.mjs --secrets-only` |
| 16 | `og-worker.test.mjs` |
