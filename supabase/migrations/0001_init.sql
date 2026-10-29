-- 0001_init: tables, indexes and default-deny privileges.
-- Money is numeric(12,2), never float. Balances are derived, never stored.

-- Default deny: functions and tables created from here on are NOT callable/readable by
-- anon/authenticated unless a migration grants it explicitly (see ci/function_allowlist.txt).
alter default privileges revoke execute on functions from public;
alter default privileges in schema public revoke execute on functions from anon, authenticated;
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Accounts
-- ---------------------------------------------------------------------------
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  full_name text not null default '' check (char_length(full_name) <= 120),
  email text,
  phone text check (phone is null or char_length(phone) <= 32),
  telegram_username text check (telegram_username is null or telegram_username ~ '^[A-Za-z0-9_]{5,32}$'),
  telegram_chat_id bigint unique,
  telegram_link_code text unique,
  telegram_link_expires_at timestamptz,
  notify_prefs jsonb not null default '{"payment": true, "daily": true, "withdrawal": true}'::jsonb,
  role text not null default 'user' check (role in ('user', 'admin')),
  account_status text not null default 'pending'
    check (account_status in ('pending', 'active', 'rejected', 'suspended')),
  status_reason text,
  commission_pct numeric(5, 2) check (commission_pct is null or commission_pct between 0 and 100),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index profiles_status_idx on public.profiles (account_status, created_at);

-- ---------------------------------------------------------------------------
-- Payment links
-- ---------------------------------------------------------------------------
create table public.reserved_slugs (
  slug text primary key
);

create table public.payment_links (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$' and slug not like '%--%'),
  display_name text not null check (char_length(btrim(display_name)) between 1 and 60),
  note text check (note is null or char_length(note) <= 280),
  min_usd numeric(12, 2) check (min_usd is null or min_usd > 0),
  max_usd numeric(12, 2) check (max_usd is null or max_usd > 0),
  quick_amounts numeric(12, 2)[] not null default '{10,25,50,100,250,500}'
    check (cardinality(quick_amounts) <= 8),
  is_active boolean not null default true,
  disabled_by_admin boolean not null default false,
  disabled_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (min_usd is null or max_usd is null or min_usd <= max_usd)
);
create index payment_links_user_idx on public.payment_links (user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Payments (one row per Lightning invoice)
-- ---------------------------------------------------------------------------
create table public.payments (
  id uuid primary key default gen_random_uuid(),
  link_id uuid not null references public.payment_links (id) on delete restrict,
  user_id uuid not null references public.profiles (id) on delete restrict,
  amount_usd numeric(12, 2) not null check (amount_usd > 0),
  amount_sats bigint not null check (amount_sats > 0),
  btc_usd_rate numeric(14, 2) not null check (btc_usd_rate > 0),
  commission_pct numeric(5, 2) not null check (commission_pct between 0 and 100),
  commission_usd numeric(12, 2) not null check (commission_usd >= 0),
  net_usd numeric(12, 2) not null,
  payment_hash text not null unique check (payment_hash ~ '^[0-9a-f]{64}$'),
  bolt11 text not null,
  status text not null default 'pending' check (status in ('pending', 'settled', 'expired', 'failed')),
  expires_at timestamptz not null,
  settled_at timestamptz,
  amt_paid_sat bigint,
  settle_source text check (settle_source is null or settle_source in ('watcher', 'status', 'admin')),
  last_checked_at timestamptz,
  domain text,
  created_at timestamptz not null default now(),
  check (net_usd = amount_usd - commission_usd),
  check ((status = 'settled') = (settled_at is not null))
);
create index payments_user_created_idx on public.payments (user_id, created_at desc);
create index payments_user_settled_idx on public.payments (user_id, settled_at) where status = 'settled';
create index payments_settled_at_idx on public.payments (settled_at) where status = 'settled';
create index payments_pending_idx on public.payments (created_at) where status = 'pending';
create index payments_link_idx on public.payments (link_id);

-- ---------------------------------------------------------------------------
-- Daily statements: one row per user per 19:00 -> 19:00 Asia/Dhaka cycle
-- ---------------------------------------------------------------------------
create table public.daily_invoices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete restrict,
  cycle_date date not null,
  cycle_start timestamptz not null,
  cycle_end timestamptz not null,
  payment_count integer not null default 0,
  gross_usd numeric(12, 2) not null default 0,
  commission_usd numeric(12, 2) not null default 0,
  net_usd numeric(12, 2) not null default 0,
  status text not null default 'open' check (status in ('open', 'closed', 'paid_out')),
  generated_at timestamptz not null default now(),
  notified_at timestamptz,
  unique (user_id, cycle_date),
  check (cycle_end > cycle_start)
);
create index daily_invoices_cycle_idx on public.daily_invoices (cycle_date desc);

-- ---------------------------------------------------------------------------
-- Payouts
-- ---------------------------------------------------------------------------
create table public.payout_destinations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  method text not null,
  label text not null check (char_length(btrim(label)) between 1 and 60),
  details jsonb not null default '{}'::jsonb check (jsonb_typeof(details) = 'object'),
  created_at timestamptz not null default now()
);
create index payout_destinations_user_idx on public.payout_destinations (user_id);

create table public.withdrawals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete restrict,
  amount_usd numeric(12, 2) not null check (amount_usd > 0),
  method text not null,
  destination_id uuid references public.payout_destinations (id) on delete set null,
  destination_snapshot jsonb not null,
  status text not null default 'requested' check (status in ('requested', 'approved', 'paid', 'rejected')),
  admin_id uuid references public.profiles (id),
  reference text,
  reason text,
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  paid_at timestamptz
);
create index withdrawals_user_idx on public.withdrawals (user_id, created_at desc);
create index withdrawals_status_idx on public.withdrawals (status, created_at);
-- One open request per user at a time (also enforced with a row lock in request_withdrawal).
create unique index withdrawals_one_open_per_user on public.withdrawals (user_id)
  where status in ('requested', 'approved');

-- ---------------------------------------------------------------------------
-- Platform configuration
-- ---------------------------------------------------------------------------
create table public.site_domains (
  hostname text primary key check (hostname ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$'),
  label text not null default '',
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.app_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by uuid
);

create table public.audit_log (
  id bigint generated always as identity primary key,
  actor_id uuid,
  action text not null,
  target_table text,
  target_id text,
  before jsonb,
  after jsonb,
  reason text,
  created_at timestamptz not null default now()
);
create index audit_log_created_idx on public.audit_log (created_at desc);
create index audit_log_target_idx on public.audit_log (target_table, target_id);

-- Telegram outbox, drained by the telegram-notify function.
create table public.notification_outbox (
  id bigint generated always as identity primary key,
  audience text not null check (audience in ('user', 'admin')),
  user_id uuid references public.profiles (id) on delete cascade,
  chat_id bigint not null,
  kind text not null,
  body text not null check (char_length(body) <= 4000),
  dedupe_key text unique,
  status text not null default 'queued' check (status in ('queued', 'sending', 'sent', 'failed')),
  attempts integer not null default 0,
  last_error text,
  locked_at timestamptz,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
create index notification_outbox_queued_idx on public.notification_outbox (id) where status in ('queued', 'sending');

-- Fixed-window counters for create-invoice / payment-status rate limits.
create table public.rate_limits (
  bucket text not null,
  window_start timestamptz not null,
  hits integer not null default 0,
  primary key (bucket, window_start)
);

-- Shared BTC/USD cache so all function isolates reuse one rate for <= 60 s.
create table public.fx_rates (
  pair text primary key,
  rate numeric(14, 2) not null check (rate > 0),
  sources text[] not null default '{}',
  fetched_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Row level security on every table. Policies live in 0002.
-- ---------------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.reserved_slugs enable row level security;
alter table public.payment_links enable row level security;
alter table public.payments enable row level security;
alter table public.daily_invoices enable row level security;
alter table public.payout_destinations enable row level security;
alter table public.withdrawals enable row level security;
alter table public.site_domains enable row level security;
alter table public.app_settings enable row level security;
alter table public.audit_log enable row level security;
alter table public.notification_outbox enable row level security;
alter table public.rate_limits enable row level security;
alter table public.fx_rates enable row level security;

-- Belt and braces for projects whose default privileges predate this migration.
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
