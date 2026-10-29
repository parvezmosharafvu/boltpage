-- 0002_core: settings, helper functions, profile guard, signup trigger, RLS policies.

-- ---------------------------------------------------------------------------
-- Settings (admin-editable through admin_set_setting)
-- ---------------------------------------------------------------------------
insert into public.app_settings (key, value) values
  ('min_usd', '10'),
  ('max_usd', '1000'),
  ('invoice_expiry_seconds', '3600'),
  ('default_commission_pct', '5'),
  ('withdrawal_min_usd', '20'),
  ('withdrawal_auto_approve_enabled', 'false'),
  ('withdrawal_auto_approve_below_usd', '0'),
  ('payout_methods', '[]'),
  ('telegram_bot_username', '""'),
  ('checkout_enabled', 'false'),
  ('admin_require_mfa', 'false'),
  ('quick_amounts_default', '[10, 25, 50, 100, 250, 500]'),
  ('max_links_per_user', '20'),
  ('rate_limit_ip_per_min', '10'),
  ('rate_limit_link_per_min', '30'),
  ('rate_limit_status_per_min', '120'),
  ('support_contact', '""');

create function public._setting(p_key text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select value from public.app_settings where key = p_key
$$;

create function public._setting_num(p_key text) returns numeric
language sql stable security definer set search_path = '' as $$
  select (value #>> '{}')::numeric from public.app_settings where key = p_key
$$;

create function public._setting_bool(p_key text) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select (value #>> '{}')::boolean from public.app_settings where key = p_key), false)
$$;

create function public._setting_text(p_key text) returns text
language sql stable security definer set search_path = '' as $$
  select coalesce((select value #>> '{}' from public.app_settings where key = p_key), '')
$$;

-- ---------------------------------------------------------------------------
-- Identity helpers. Used inside RLS policies, so authenticated may execute them.
-- ---------------------------------------------------------------------------
create function public.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role = 'admin' and p.account_status = 'active'
    )
    and (
      not public._setting_bool('admin_require_mfa')
      or coalesce(auth.jwt() ->> 'aal', '') = 'aal2'
    )
$$;

create function public.is_active_user() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.profiles p where p.id = auth.uid() and p.account_status = 'active'
  )
$$;

create function public._assert_active() returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_active_user() then
    raise exception 'account_not_active' using errcode = '42501';
  end if;
end $$;

create function public._assert_admin() returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_admin() then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
end $$;

create function public._audit(
  p_action text, p_table text, p_target text, p_before jsonb, p_after jsonb, p_reason text default null
) returns void
language sql security definer set search_path = '' as $$
  insert into public.audit_log (actor_id, action, target_table, target_id, before, after, reason)
  values (auth.uid(), p_action, p_table, p_target, p_before, p_after, p_reason)
$$;

-- ---------------------------------------------------------------------------
-- Settlement cycle: 19:00 -> 19:00 Asia/Dhaka. cycle_date is the Dhaka date the cycle ENDS on.
-- Dhaka has no DST, but we still compute through the named zone.
-- ---------------------------------------------------------------------------
create function public._cycle_date_for(p_ts timestamptz) returns date
language sql stable set search_path = '' as $$
  select case
    when (p_ts at time zone 'Asia/Dhaka')::time >= time '19:00'
      then (p_ts at time zone 'Asia/Dhaka')::date + 1
    else (p_ts at time zone 'Asia/Dhaka')::date
  end
$$;

create function public._cycle_bounds(p_cycle_date date, out cycle_start timestamptz, out cycle_end timestamptz)
language sql stable set search_path = '' as $$
  select ((p_cycle_date - 1) + time '19:00') at time zone 'Asia/Dhaka',
         (p_cycle_date + time '19:00') at time zone 'Asia/Dhaka'
$$;

-- ---------------------------------------------------------------------------
-- Telegram outbox helpers. Recipients are resolved at enqueue time.
-- ---------------------------------------------------------------------------
create function public._notify_user(p_user uuid, p_kind text, p_body text, p_dedupe text default null)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_chat bigint;
  v_prefs jsonb;
  v_pref text;
begin
  select telegram_chat_id, notify_prefs into v_chat, v_prefs from public.profiles where id = p_user;
  if v_chat is null then
    return;
  end if;
  v_pref := case p_kind
    when 'payment_settled' then 'payment'
    when 'daily_statement' then 'daily'
    when 'withdrawal' then 'withdrawal'
  end;
  if v_pref is not null and coalesce((v_prefs ->> v_pref)::boolean, true) = false then
    return;
  end if;
  insert into public.notification_outbox (audience, user_id, chat_id, kind, body, dedupe_key)
  values ('user', p_user, v_chat, p_kind, left(p_body, 4000), p_dedupe)
  on conflict (dedupe_key) do nothing;
end $$;

create function public._notify_admins(p_kind text, p_body text, p_dedupe text default null)
returns void
language sql security definer set search_path = '' as $$
  insert into public.notification_outbox (audience, user_id, chat_id, kind, body, dedupe_key)
  select 'admin', p.id, p.telegram_chat_id, p_kind, left(p_body, 4000),
         case when p_dedupe is null then null else p_dedupe || ':' || p.id::text end
  from public.profiles p
  where p.role = 'admin' and p.account_status = 'active' and p.telegram_chat_id is not null
  on conflict (dedupe_key) do nothing
$$;

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------
create function public._touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- Users may edit their own name/phone/telegram username/notification prefs, nothing else.
-- SECURITY DEFINER RPCs run as the table owner, so admin/service paths are not affected.
create function public._profiles_guard() returns trigger
language plpgsql as $$
begin
  if current_user in ('anon', 'authenticated') then
    if new.id is distinct from old.id
      or new.email is distinct from old.email
      or new.role is distinct from old.role
      or new.account_status is distinct from old.account_status
      or new.status_reason is distinct from old.status_reason
      or new.commission_pct is distinct from old.commission_pct
      or new.telegram_chat_id is distinct from old.telegram_chat_id
      or new.telegram_link_code is distinct from old.telegram_link_code
      or new.telegram_link_expires_at is distinct from old.telegram_link_expires_at
      or new.created_at is distinct from old.created_at
    then
      raise exception 'protected_profile_field' using errcode = '42501';
    end if;
  end if;
  new.updated_at := now();
  return new;
end $$;

create trigger profiles_guard before update on public.profiles
  for each row execute function public._profiles_guard();

create trigger payment_links_touch before update on public.payment_links
  for each row execute function public._touch_updated_at();

-- New auth user -> pending profile. Metadata can never set role or status.
create function public._handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_meta jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  v_tg text;
  v_name text;
begin
  v_tg := nullif(regexp_replace(btrim(coalesce(v_meta ->> 'telegram_username', '')), '^@+', ''), '');
  if v_tg is not null and v_tg !~ '^[A-Za-z0-9_]{5,32}$' then
    v_tg := null;
  end if;
  v_name := left(btrim(coalesce(v_meta ->> 'full_name', '')), 120);

  insert into public.profiles (id, email, full_name, phone, telegram_username)
  values (new.id, new.email, v_name, nullif(left(btrim(coalesce(v_meta ->> 'phone', '')), 32), ''), v_tg)
  on conflict (id) do nothing;

  perform public._notify_admins(
    'signup',
    format('New account waiting for approval: %s <%s>', coalesce(nullif(v_name, ''), '(no name)'), new.email),
    'signup:' || new.id::text
  );
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function public._handle_new_user();

create function public._handle_user_email_change() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.profiles set email = new.email where id = new.id;
  return new;
end $$;

create trigger on_auth_user_email_changed after update of email on auth.users
  for each row when (old.email is distinct from new.email)
  execute function public._handle_user_email_change();

-- ---------------------------------------------------------------------------
-- RLS policies. Users see only their own rows, and only while active.
-- Admin access requires role=admin, active, and aal2 when admin_require_mfa is on.
-- ---------------------------------------------------------------------------
create policy profiles_select on public.profiles for select to authenticated
  using (id = auth.uid() or public.is_admin());
create policy profiles_update_own on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

create policy payment_links_select on public.payment_links for select to authenticated
  using ((user_id = auth.uid() and public.is_active_user()) or public.is_admin());

create policy payments_select on public.payments for select to authenticated
  using ((user_id = auth.uid() and public.is_active_user()) or public.is_admin());

create policy daily_invoices_select on public.daily_invoices for select to authenticated
  using ((user_id = auth.uid() and public.is_active_user()) or public.is_admin());

create policy payout_destinations_select on public.payout_destinations for select to authenticated
  using ((user_id = auth.uid() and public.is_active_user()) or public.is_admin());

create policy withdrawals_select on public.withdrawals for select to authenticated
  using ((user_id = auth.uid() and public.is_active_user()) or public.is_admin());

create policy site_domains_select on public.site_domains for select to authenticated
  using (public.is_active_user() or public.is_admin());

create policy app_settings_select on public.app_settings for select to authenticated
  using (public.is_admin());

create policy audit_log_select on public.audit_log for select to authenticated
  using (public.is_admin());

create policy notification_outbox_select on public.notification_outbox for select to authenticated
  using (public.is_admin());

-- reserved_slugs, rate_limits, fx_rates: no policies (service role / definer functions only).

grant select on public.profiles, public.payment_links, public.payments, public.daily_invoices,
  public.payout_destinations, public.withdrawals, public.site_domains, public.app_settings,
  public.audit_log, public.notification_outbox
  to authenticated;
grant update on public.profiles to authenticated;

grant execute on function public.is_admin() to authenticated;
grant execute on function public.is_active_user() to authenticated;
