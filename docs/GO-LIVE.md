# Go-live checklist

Work top to bottom. `checkout_enabled` stays **false** until step 9 passes.

## 0. Legal and compliance (before any real money)
Accepting payments for third parties and paying them out can be regulated activity (money transmission,
payment services, foreign-exchange rules, KYC/AML, tax reporting) in your country and in your users'
countries. Get advice for every jurisdiction you operate in, replace the template `terms.html` /
`privacy.html` / `contact.html`, and decide what identity checks the approval step must include.

## 1. LND node (operator's own, public)
- Fully synced mainnet LND (`lncli getinfo`: `synced_to_chain` and `synced_to_graph` true).
- **Public node with public channels and inbound liquidity** (we create invoices with `private: false`,
  i.e. no route hints). Aim for inbound ≥ 2× your expected daily volume, spread over well-connected peers.
- Keep `lnd.conf` REST bound to localhost (`restlisten=127.0.0.1:8080`); the tunnel reaches it locally.

## 2. Invoice-only macaroon
```bash
lncli bakemacaroon invoices:read invoices:write info:read offchain:read --save_to=invoice.macaroon
xxd -ps -u -c 1000 invoice.macaroon | tr 'A-F' 'a-f'     # -> LND_INVOICE_MACAROON_HEX
```
Never upload `admin.macaroon` anywhere. Store the hex only in Supabase secrets.

## 3. Cloudflare Tunnel + Access
- `cloudflared tunnel create lnd-rest`, ingress `https://<lnd-tunnel-hostname>` → `https://localhost:8080`
  with `noTLSVerify: true` (LND's self-signed cert stays local).
- Zero Trust → Access → Application for `<lnd-tunnel-hostname>`, policy **Service Auth** only, with a new
  service token → `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET`.
- Check: without headers you get a 302/403; with headers + macaroon `GET /v1/getinfo` returns JSON.

## 4. Supabase
```bash
supabase link --project-ref <project-ref>
supabase db push
supabase secrets set ...            # docs/SECRETS.md
supabase functions deploy
```
- Enable `pg_cron` and `pg_net` (Database → Extensions) **before** `db push`, or re-run `0009_cron.sql`'s
  `do $cron$ … $cron$` block afterwards.
- Vault: `project_url` and `cron_secret` (docs/SECRETS.md). Check `select jobname, schedule from cron.job;`.
- Auth: site URL, redirect URLs for every domain (`/login`, `/reset`), email confirmation on, leaked-password
  protection on, MFA (TOTP) enabled.
- Bootstrap the first admin in the SQL editor (runs as `postgres`, which the profile guard allows):
  ```sql
  update public.profiles set role = 'admin', account_status = 'active' where email = '<you@example.com>';
  ```
- Every admin: Dashboard → Settings → *Set up two-factor*, scan the QR in an authenticator app and verify a
  code (this session is now aal2). Then Admin → Settings → `admin_require_mfa = true`. The switch is refused
  from a session without two-factor, so you cannot lock yourself out.
- Admin → Payment methods: add the methods you pay out with (they are only ever shown inside the dashboard).

## 5. Settings (Admin → Settings)
`min_usd` 10, `max_usd` 1000, `invoice_expiry_seconds` 3600, `default_commission_pct`, `withdrawal_min_usd`,
`payout_methods`, `telegram_bot_username`, `support_contact`. Auto-approve stays off unless you decide otherwise.

## 6. Cloudflare Workers + domains
```bash
SUPABASE_URL=https://<project-ref>.supabase.co SUPABASE_ANON_KEY=<anon> npm run config
npx wrangler deploy                                   # static site first (custom domains create DNS + certs)
cd worker && npx wrangler secret put SUPABASE_URL && npx wrangler secret put SUPABASE_ANON_KEY && npx wrangler deploy
```
Replace the `pay.example.*` placeholders in both `wrangler.jsonc` files with your hostnames first; each one
must be in a zone on the Cloudflare account `wrangler whoami` shows, with no existing CNAME record.
Admin → Domains: add each hostname. Visit `/` and `/<slug>` on each; an unknown host shows 404.

## 7. Telegram
BotFather → new bot (privacy on). Set secrets, then Admin → Settings → **Register webhook**, then
**Webhook info** shows your function URL with no errors. Connect your own Telegram from Dashboard → Settings,
then **Send me a test**.

## 8. Security review
- `npm test`, `npm run test:deno`, `npm run test:e2e`, and the gitleaks job are green in CI.
- `curl -I https://<host>/` shows the CSP and HSTS headers from `public/_headers`.
- `public/config.js` contains the anon key only (the config script refuses a service-role key).
- Supabase Advisors (security + performance) show no RLS or `search_path` warnings.

## 9. $10 live test
1. Approve a test seller, create a link, open it on a phone.
2. Temporarily set `checkout_enabled = true`, pay $10 from a Lightning wallet, then **Open in Cash App** with
   a second $10 from a real account.
3. Confirm: success screen within seconds; payment `settled` with rate and sats; Telegram message; correct
   commission/net; the statement appears after 19:05 Dhaka (or Run now).
4. Request and pay out a withdrawal end to end.
5. If anything is off, set `checkout_enabled = false` and fix before inviting users.

## 10. Launch
Leave `checkout_enabled = true`, start approving accounts, and watch the RUNBOOK daily checks for the first week.
