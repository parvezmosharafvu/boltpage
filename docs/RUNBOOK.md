# Runbook

## Daily checks
- Admin → **Node**: synced chain + graph, active channels, inbound liquidity comfortably above a day's volume.
- Admin → **Withdrawals** queue; Admin → **Approvals** queue.
- Telegram admin chat: health alerts arrive at most once an hour per problem.

## Common incidents

### Checkout says "Lightning payments are temporarily unavailable" (`lightning_unavailable`)
1. `curl https://<project-ref>.supabase.co/functions/v1/health` → `lnd:false` means the tunnel or node.
2. On the node host: `systemctl status cloudflared lnd`, `lncli getinfo`.
3. A `302`/`403` from the tunnel means the Access service token or policy changed (see SECRETS rotation).
4. If it will take a while: Admin → Settings → `checkout_enabled = false` (payers see a polite notice).

### `rate_unavailable`
All three price sources failed. Check outbound network from functions; it self-heals on the next request.

### A payer says they paid but the page still waits
1. Admin → Payments → find by receipt code; note status.
2. On the node: `lncli lookupinvoice <payment_hash>`.
3. If LND says `SETTLED`, the watcher will settle it within a minute. If cron is broken, check
   `select * from cron.job_run_details order by start_time desc limit 20;` and the Vault secrets.
4. Only if the node shows it settled and automation cannot catch up: **Mark settled** with an audit reason.
   Never edit amounts.

### Late settlement after a statement closed
The 19:05 job regenerates cycle D and D−1. For older cycles run Admin → Settlement → **Run now** with the date.
`paid_out` statements keep their status; numbers are recomputed.

### Telegram messages not arriving
- Admin → Settings → **Webhook info** (`last_error_message`).
- `select status, count(*) from notification_outbox group by 1;` — many `failed` with `telegram 403` means
  users blocked the bot (expected; they can reconnect).
- Re-register with **Register webhook** after rotating `TELEGRAM_WEBHOOK_SECRET`.

### Abuse report on a link
Admin → Links → **Disable** (reason required). For the account: Admin → Users → **Suspend**. Both are audited,
take effect immediately on every domain and for crawlers.

## Adding a custom domain
1. Cloudflare: add the hostname as a custom domain of `boltpage-site` (`wrangler.jsonc` routes) and as a
   route of `boltpage-og-preview` (`worker/wrangler.jsonc`), then deploy both.
2. Supabase Auth → URL configuration: add `https://<host>/reset` and `https://<host>/login` to redirect URLs.
3. Admin → Domains → add the hostname (active). Links now work there; unknown hosts keep showing 404.

## Deploys
```bash
npm ci && npm test                      # copy check + unit + SQL
supabase db push                         # migrations (append-only; never edit an applied file)
supabase functions deploy                # all functions
SUPABASE_URL=… SUPABASE_ANON_KEY=… npm run config && npx wrangler deploy
(cd worker && npx wrangler deploy)
```

## Useful SQL
```sql
-- Pending invoices older than expiry (should be ~0 if the watcher runs)
select count(*) from payments where status = 'pending' and expires_at < now() - interval '5 minutes';
-- Balances
select p.email, b.* from user_balances b join profiles p on p.id = b.user_id order by available_usd desc;
-- Recent admin actions
select created_at, action, target_table, target_id, reason from audit_log order by id desc limit 50;
```
