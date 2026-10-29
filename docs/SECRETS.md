# Secrets and configuration

Nothing secret is ever committed, written to `public/`, or logged. Values below are placeholders.

| Name | Secret? | Where it is set | Used by |
|---|---|---|---|
| `SUPABASE_URL` | no | `npm run config` env (→ `public/config.js`), `worker/wrangler.jsonc` vars, auto-injected in functions | browser, preview Worker, functions |
| `SUPABASE_ANON_KEY` | no (public by design) | `npm run config` env (→ `public/config.js`); `wrangler secret put SUPABASE_ANON_KEY` for the preview Worker; auto-injected in functions | browser, preview Worker |
| `SUPABASE_SERVICE_ROLE_KEY` | **yes** | auto-injected into Supabase functions only | functions (service RPCs) |
| `LND_REST_URL` | semi | `supabase secrets set LND_REST_URL=https://<lnd-tunnel-hostname>` | create-invoice, payment-status, lnd-watcher, health, node-status |
| `LND_INVOICE_MACAROON_HEX` | **yes** | `supabase secrets set` | same |
| `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET` | **yes** | `supabase secrets set` | same (Cloudflare Access service token in front of the tunnel) |
| `TELEGRAM_BOT_TOKEN` | **yes** | `supabase secrets set` | telegram-webhook, telegram-notify, admin-actions |
| `TELEGRAM_WEBHOOK_SECRET` | **yes** | `supabase secrets set` (random 32+ chars, `[A-Za-z0-9_-]`) | telegram-webhook (verifies header), admin-actions (registers webhook) |
| `CRON_SECRET` | **yes** | `supabase secrets set` **and** Vault: `select vault.create_secret('<value>', 'cron_secret')` | pg_cron → functions (`x-cron-secret`) |
| `project_url` (Vault) | no | `select vault.create_secret('https://<project-ref>.supabase.co', 'project_url')` | `_invoke_function` in `0009_cron.sql` |
| `IP_HASH_SALT` | **yes** | `supabase secrets set` | create-invoice, payment-status (rate-limit buckets never store raw IPs) |
| `BRAND_NAME` | no | `npm run config` env, Worker var, `supabase secrets set BRAND_NAME=...` | UI, OG, invoice memo |
| `CLOUDFLARE_API_TOKEN` | **yes** | GitHub Actions secret (deploy job, if you add one) / local shell | `wrangler deploy` |

## Commands

```bash
# Supabase function secrets (never in git)
supabase secrets set \
  LND_REST_URL=https://<lnd-tunnel-hostname> \
  LND_INVOICE_MACAROON_HEX=<hex> \
  CF_ACCESS_CLIENT_ID=<id>.access CF_ACCESS_CLIENT_SECRET=<secret> \
  TELEGRAM_BOT_TOKEN=<token> TELEGRAM_WEBHOOK_SECRET=<random> \
  CRON_SECRET=<random> IP_HASH_SALT=<random> BRAND_NAME=Boltpage

# Public config for the static site (anon key only; the script refuses service-role keys)
SUPABASE_URL=https://<project-ref>.supabase.co SUPABASE_ANON_KEY=<anon> npm run config

# Preview Worker
cd worker && wrangler secret put SUPABASE_ANON_KEY
```

Generate random secrets with `openssl rand -hex 32`.

## Rotation

- **Macaroon:** bake a new invoice-only macaroon, `supabase secrets set LND_INVOICE_MACAROON_HEX=…`, then
  delete the old root key ID on the node (`lncli deletemacaroonid <id>`).
- **Access token:** create a new service token, add it to the Access policy, update both secrets, then
  revoke the old token.
- **Telegram:** `/revoke` in BotFather → set `TELEGRAM_BOT_TOKEN` → admin panel → Settings → *Register webhook*.
- **Cron secret:** update the function secret and the Vault entry together
  (`select vault.update_secret((select id from vault.secrets where name='cron_secret'), '<new>')`).

## Guard rails

- `.gitignore` excludes `.env*`, `public/config.js`, `.dev.vars`.
- CI runs gitleaks (`.gitleaks.toml` adds rules for macaroons, Telegram tokens and `sb_secret_` keys)
  and `node ci/check_public_copy.mjs --secrets-only` over `public/` and the Worker.
- Functions log error messages only, never headers or bodies.
