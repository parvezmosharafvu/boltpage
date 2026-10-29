-- Local development only (`supabase db reset` runs this after migrations). Never applied in production.
insert into public.site_domains (hostname, label, is_active) values
  ('localhost', 'Local dev', true),
  ('127.0.0.1', 'Local dev (IP)', true)
on conflict (hostname) do nothing;

update public.app_settings set value = '"boltpage_local_bot"' where key = 'telegram_bot_username';
update public.app_settings
   set value = '[{"id": "wallet_a", "label": "Wallet A", "fields": [{"key": "account", "label": "Account number"}, {"key": "name", "label": "Account name"}]}]'
 where key = 'payout_methods';
-- checkout_enabled stays false until you point LND_REST_URL at a node (or a mock) and flip it.
