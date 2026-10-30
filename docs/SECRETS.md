# Secrets and configuration

Nothing secret is ever committed, written to `public/`, or logged. Values below are placeholders.

| Name | Secret? | Where it is set | Used by |
|---|---|---|---|
| `SUPABASE_URL` | no | `npm run config` env (→ `public/config.js`); `wrangler secret put SUPABASE_URL` for the preview Worker (keeps the project ref out of git); auto-injected in functions | browser, preview Worker, functions |
| `SUPABASE_ANON_KEY` | no (public by design) | `npm run config` env (→ `public/config.js`); `wrangler secret put SUPABASE_ANON_KEY` for the preview Worker; auto-injected in functions | browser, preview Worker |
| `SUPABASE_SERVICE_ROLE_KEY` | **yes** | auto-injected into Supabase functions only | functions (service RPCs) |
| `LND_REST_URL` | semi | `supabase secrets set LND_REST_URL=https://<lnd-tunnel-hostname>` | create-invoice, payment-status, lnd-watcher, health, node-status |
| `LND_INVOICE_MACAROON_HEX` | **yes** | `supabase secrets set` | same |
| `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET` | **yes** | `supabase secrets set` | same (Cloudflare Access service token in front of the tunnel) |
| `TELEGRAM_BOT_TOKEN` | **yes** | `supabase secrets set` | telegram-webhook, telegram-notify, admin-actions |
| `TELEGRAM_WEBHOOK_SECRET` | **yes** | optional: derived from the service key when unset; or `supabase secrets set` (random 32+ chars, `[A-Za-z0-9_-]`) | telegram-webhook (verifies header), admin-actions (registers webhook) |
| `cron_secret` (Vault) | **yes** | generated inside the database by migration `0011` (never leaves it); functions check it via `cron_secret_matches()`. An optional `CRON_SECRET` function secret takes precedence and must then equal it | pg_cron → functions (`x-cron-secret`) |
| `project_url` (Vault) | no | `select vault.create_secret('https://<project-ref>.supabase.co', 'project_url')` | `_invoke_function` in `0009_cron.sql` |
| `IP_HASH_SALT` | **yes** | optional: the service key is used when unset; or `supabase secrets set` | create-invoice, payment-status (rate-limit buckets never store raw IPs) |
| `BRAND_NAME` | no | `npm run config` env, Worker var, `supabase secrets set BRAND_NAME=...` | UI, OG, invoice memo |
| `CLOUDFLARE_API_TOKEN` | **yes** | GitHub Actions secret (deploy job, if you add one) / local shell | `wrangler deploy` |

## Commands

```bash
# Supabase function secrets (never in git)
supabase secrets set \
  LND_REST_URL=https://<lnd-tunnel-hostname> \
  LND_INVOICE_MACAROON_HEX=<hex> \
  CF_ACCESS_CLIENT_ID=<id>.access CF_ACCESS_CLIENT_SECRET=<secret> \
  TELEGRAM_BOT_TOKEN=<token> BRAND_NAME=Boltpage
# Optional overrides: TELEGRAM_WEBHOOK_SECRET and IP_HASH_SALT (derived when unset),
# CRON_SECRET (the Vault cron_secret is used when unset).

# Vault, once in the SQL editor: the URL pg_cron calls (cron_secret comes from migration 0011)
#   select vault.create_secret('https://<project-ref>.supabase.co', 'project_url');

# Public config for the static site (anon key only; the script refuses service-role keys)
SUPABASE_URL=https://<project-ref>.supabase.co SUPABASE_ANON_KEY=<anon> npm run config

# Preview Worker (secrets survive later deploys)
cd worker && wrangler secret put SUPABASE_URL && wrangler secret put SUPABASE_ANON_KEY
```

Generate random secrets with `openssl rand -hex 32`.

## Rotation

- **Macaroon:** bake a new invoice-only macaroon, `supabase secrets set LND_INVOICE_MACAROON_HEX=…`, then
  delete the old root key ID on the node (`lncli deletemacaroonid <id>`).
- **Access token:** create a new service token, add it to the Access policy, update both secrets, then
  revoke the old token.
- **Telegram:** `/revoke` in BotFather → set `TELEGRAM_BOT_TOKEN` → admin panel → Settings → *Register webhook*.
- **Cron secret:** `select vault.update_secret((select id from vault.secrets where name = 'cron_secret'),
  encode(extensions.gen_random_bytes(32), 'hex'));` (and the `CRON_SECRET` function secret, if you set one).
- **Service key:** rotating it also changes the derived IP salt and Telegram webhook secret; press
  *Register webhook* again afterwards.

## Guard rails

- `.gitignore` excludes `.env*`, `public/config.js`, `.dev.vars`.
- CI runs gitleaks (`.gitleaks.toml` adds rules for macaroons, Telegram tokens and `sb_secret_` keys)
  and `node ci/check_public_copy.mjs --secrets-only` over `public/` and the Worker.
- Functions log error messages only, never headers or bodies.
