-- 0007_admin: every admin write goes through one of these SECURITY DEFINER RPCs, each of
-- which checks is_admin() (role + active + MFA when required) and writes audit_log.
-- Admin reads use the tables directly; RLS policies grant admins select.

create function public.admin_list_accounts(p_status text default null, p_search text default null)
returns table (
  id uuid, full_name text, email text, phone text, telegram_username text, telegram_connected boolean,
  role text, account_status text, status_reason text, commission_pct numeric, effective_commission_pct numeric,
  created_at timestamptz, link_count bigint, settled_count bigint, gross_usd numeric, net_usd numeric,
  available_usd numeric
)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_q text := nullif(btrim(coalesce(p_search, '')), '');
begin
  perform public._assert_admin();
  return query
  select p.id, p.full_name, p.email, p.phone, p.telegram_username, p.telegram_chat_id is not null,
         p.role, p.account_status, p.status_reason, p.commission_pct,
         coalesce(p.commission_pct, public._setting_num('default_commission_pct')),
         p.created_at,
         (select count(*) from public.payment_links l where l.user_id = p.id),
         t.n, t.gross, t.net, b.available_usd
  from public.profiles p
  cross join lateral (
    select count(*) as n, coalesce(sum(x.amount_usd), 0) as gross, coalesce(sum(x.net_usd), 0) as net
    from public.payments x where x.user_id = p.id and x.status = 'settled'
  ) t
  cross join lateral public._balance(p.id) b
  where (p_status is null or p.account_status = p_status)
    and (
      v_q is null
      or p.email ilike '%' || v_q || '%'
      or p.full_name ilike '%' || v_q || '%'
      or p.phone ilike '%' || v_q || '%'
      or p.telegram_username ilike '%' || v_q || '%'
    )
  order by p.created_at desc
  limit 500;
end $$;

create function public.admin_set_account_status(p_user uuid, p_status text, p_reason text default null)
returns public.profiles
language plpgsql security definer set search_path = '' as $$
declare
  v_before public.profiles;
  v_after public.profiles;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  perform public._assert_admin();
  if p_status not in ('pending', 'active', 'rejected', 'suspended') then
    raise exception 'status_invalid';
  end if;
  if p_user = auth.uid() then
    raise exception 'cannot_change_own_status';
  end if;
  if p_status in ('rejected', 'suspended') and v_reason is null then
    raise exception 'reason_required';
  end if;

  select * into v_before from public.profiles where id = p_user for update;
  if not found then
    raise exception 'not_found';
  end if;

  update public.profiles
     set account_status = p_status,
         status_reason = case when p_status = 'active' then null else v_reason end
   where id = p_user
  returning * into v_after;

  perform public._audit('account.set_status', 'profiles', p_user::text,
    jsonb_build_object('account_status', v_before.account_status, 'status_reason', v_before.status_reason),
    jsonb_build_object('account_status', v_after.account_status, 'status_reason', v_after.status_reason),
    v_reason);

  if p_status = 'active' and v_before.account_status <> 'active' then
    perform public._notify_user(p_user, 'account',
      'Your account is approved. You can now log in and create payment links.',
      'approved:' || p_user::text || ':' || extract(epoch from now())::bigint::text);
  end if;
  return v_after;
end $$;

create function public.admin_set_commission(p_user uuid, p_pct numeric) returns public.profiles
language plpgsql security definer set search_path = '' as $$
declare
  v_before numeric;
  v_after public.profiles;
begin
  perform public._assert_admin();
  if p_pct is not null and (p_pct < 0 or p_pct > 100 or p_pct <> round(p_pct, 2)) then
    raise exception 'commission_invalid';
  end if;
  select commission_pct into v_before from public.profiles where id = p_user for update;
  if not found then
    raise exception 'not_found';
  end if;
  update public.profiles set commission_pct = p_pct where id = p_user returning * into v_after;
  perform public._audit('account.set_commission', 'profiles', p_user::text,
    jsonb_build_object('commission_pct', v_before), jsonb_build_object('commission_pct', p_pct));
  return v_after;
end $$;

create function public.admin_set_link_disabled(p_link uuid, p_disabled boolean, p_reason text default null)
returns public.payment_links
language plpgsql security definer set search_path = '' as $$
declare
  v_before public.payment_links;
  v_after public.payment_links;
begin
  perform public._assert_admin();
  if p_disabled and nullif(btrim(coalesce(p_reason, '')), '') is null then
    raise exception 'reason_required';
  end if;
  select * into v_before from public.payment_links where id = p_link for update;
  if not found then
    raise exception 'not_found';
  end if;
  update public.payment_links
     set disabled_by_admin = p_disabled,
         disabled_reason = case when p_disabled then btrim(p_reason) end
   where id = p_link
  returning * into v_after;
  perform public._audit(case when p_disabled then 'link.disable' else 'link.enable' end,
    'payment_links', p_link::text,
    jsonb_build_object('disabled_by_admin', v_before.disabled_by_admin),
    jsonb_build_object('disabled_by_admin', v_after.disabled_by_admin), p_reason);
  return v_after;
end $$;

-- Reconciliation only. Never edits amounts; requires a reason.
create function public.admin_mark_payment_settled(p_payment uuid, p_reason text) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_before public.payments;
  v_ok boolean;
begin
  perform public._assert_admin();
  if char_length(btrim(coalesce(p_reason, ''))) < 5 then
    raise exception 'reason_required';
  end if;
  select * into v_before from public.payments where id = p_payment;
  if not found then
    raise exception 'not_found';
  end if;
  v_ok := public.settle_payment(v_before.payment_hash, now(), null, 'admin');
  if not v_ok then
    raise exception 'payment_not_settleable';
  end if;
  perform public._audit('payment.mark_settled', 'payments', p_payment::text,
    jsonb_build_object('status', v_before.status), jsonb_build_object('status', 'settled'), p_reason);
  return true;
end $$;

create function public.admin_run_daily_settlement(p_cycle_date date default null) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_rows integer;
  v_date date := coalesce(p_cycle_date, public._cycle_date_for(now()) - 1);
begin
  perform public._assert_admin();
  v_rows := public.generate_daily_invoices(v_date);
  perform public._audit('settlement.run', 'daily_invoices', v_date::text, null,
    jsonb_build_object('cycle_date', v_date, 'rows', v_rows));
  return v_rows;
end $$;

create function public.admin_mark_statement_paid(p_statement uuid) returns public.daily_invoices
language plpgsql security definer set search_path = '' as $$
declare
  v_before public.daily_invoices;
  v_after public.daily_invoices;
begin
  perform public._assert_admin();
  select * into v_before from public.daily_invoices where id = p_statement for update;
  if not found then
    raise exception 'not_found';
  end if;
  if v_before.status <> 'closed' then
    raise exception 'statement_not_closed';
  end if;
  update public.daily_invoices set status = 'paid_out' where id = p_statement returning * into v_after;
  perform public._audit('statement.paid_out', 'daily_invoices', p_statement::text,
    jsonb_build_object('status', v_before.status), jsonb_build_object('status', v_after.status));
  return v_after;
end $$;

create function public.admin_decide_withdrawal(
  p_withdrawal uuid, p_action text, p_reference text default null, p_reason text default null
) returns public.withdrawals
language plpgsql security definer set search_path = '' as $$
declare
  v_before public.withdrawals;
  v_after public.withdrawals;
  v_ref text := nullif(btrim(coalesce(p_reference, '')), '');
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  perform public._assert_admin();
  select * into v_before from public.withdrawals where id = p_withdrawal for update;
  if not found then
    raise exception 'not_found';
  end if;

  if p_action = 'approve' then
    if v_before.status <> 'requested' then
      raise exception 'withdrawal_wrong_state';
    end if;
    update public.withdrawals
       set status = 'approved', admin_id = auth.uid(), decided_at = now()
     where id = p_withdrawal returning * into v_after;
  elsif p_action = 'reject' then
    if v_before.status not in ('requested', 'approved') then
      raise exception 'withdrawal_wrong_state';
    end if;
    if v_reason is null then
      raise exception 'reason_required';
    end if;
    update public.withdrawals
       set status = 'rejected', admin_id = auth.uid(), decided_at = now(), reason = v_reason
     where id = p_withdrawal returning * into v_after;
  elsif p_action = 'paid' then
    if v_before.status <> 'approved' then
      raise exception 'withdrawal_wrong_state';
    end if;
    if v_ref is null then
      raise exception 'reference_required';
    end if;
    update public.withdrawals
       set status = 'paid', admin_id = auth.uid(), paid_at = now(), reference = v_ref
     where id = p_withdrawal returning * into v_after;
  else
    raise exception 'action_invalid';
  end if;

  perform public._audit('withdrawal.' || p_action, 'withdrawals', p_withdrawal::text,
    jsonb_build_object('status', v_before.status),
    jsonb_build_object('status', v_after.status, 'reference', v_after.reference),
    v_reason);
  perform public._notify_user(v_after.user_id, 'withdrawal',
    format('Withdrawal of $%s is now %s.%s', v_after.amount_usd, v_after.status,
           case when v_after.status = 'rejected' then ' Reason: ' || v_after.reason else '' end),
    'withdrawal:' || v_after.id::text || ':' || v_after.status);
  return v_after;
end $$;

create function public.admin_upsert_domain(p_hostname text, p_label text, p_is_active boolean)
returns public.site_domains
language plpgsql security definer set search_path = '' as $$
declare
  v_host text := lower(btrim(coalesce(p_hostname, '')));
  v_before public.site_domains;
  v_after public.site_domains;
begin
  perform public._assert_admin();
  select * into v_before from public.site_domains where hostname = v_host;
  insert into public.site_domains (hostname, label, is_active)
  values (v_host, coalesce(btrim(p_label), ''), coalesce(p_is_active, true))
  on conflict (hostname) do update set label = excluded.label, is_active = excluded.is_active
  returning * into v_after;
  perform public._audit('domain.upsert', 'site_domains', v_host, to_jsonb(v_before), to_jsonb(v_after));
  return v_after;
exception
  when check_violation then
    raise exception 'hostname_invalid';
end $$;

-- Validates each known key; unknown keys are refused.
create function public.admin_set_setting(p_key text, p_value jsonb) returns public.app_settings
language plpgsql security definer set search_path = '' as $$
declare
  v_before jsonb;
  v_after public.app_settings;
  v_num numeric;
begin
  perform public._assert_admin();
  if p_value is null then
    raise exception 'setting_invalid';
  end if;

  if p_key in ('min_usd', 'max_usd', 'default_commission_pct', 'withdrawal_min_usd',
               'withdrawal_auto_approve_below_usd', 'invoice_expiry_seconds', 'max_links_per_user',
               'rate_limit_ip_per_min', 'rate_limit_link_per_min', 'rate_limit_status_per_min') then
    if jsonb_typeof(p_value) <> 'number' then
      raise exception 'setting_invalid';
    end if;
    v_num := (p_value #>> '{}')::numeric;
    if v_num < 0 or v_num <> round(v_num, 2)
      or (p_key = 'min_usd' and (v_num <= 0 or v_num > public._setting_num('max_usd')))
      or (p_key = 'max_usd' and v_num < public._setting_num('min_usd'))
      or (p_key = 'default_commission_pct' and v_num > 100)
      or (p_key = 'invoice_expiry_seconds' and (v_num < 60 or v_num > 3600 or v_num <> trunc(v_num)))
      or (p_key = 'max_links_per_user' and (v_num < 1 or v_num > 100 or v_num <> trunc(v_num)))
      or (p_key like 'rate_limit_%' and (v_num < 1 or v_num > 10000 or v_num <> trunc(v_num)))
    then
      raise exception 'setting_invalid';
    end if;
  elsif p_key in ('withdrawal_auto_approve_enabled', 'checkout_enabled', 'admin_require_mfa') then
    if jsonb_typeof(p_value) <> 'boolean' then
      raise exception 'setting_invalid';
    end if;
  elsif p_key = 'telegram_bot_username' then
    if jsonb_typeof(p_value) <> 'string' or not ((p_value #>> '{}') ~ '^([A-Za-z0-9_]{5,32})?$') then
      raise exception 'setting_invalid';
    end if;
  elsif p_key = 'support_contact' then
    if jsonb_typeof(p_value) <> 'string' or char_length(p_value #>> '{}') > 200 then
      raise exception 'setting_invalid';
    end if;
  elsif p_key = 'quick_amounts_default' then
    if jsonb_typeof(p_value) <> 'array' or jsonb_array_length(p_value) > 8
      or exists (select 1 from jsonb_array_elements(p_value) e
                 where jsonb_typeof(e) <> 'number' or (e #>> '{}')::numeric <= 0) then
      raise exception 'setting_invalid';
    end if;
  elsif p_key = 'payout_methods' then
    if jsonb_typeof(p_value) <> 'array' or exists (
      select 1 from jsonb_array_elements(p_value) m
      where jsonb_typeof(m) <> 'object'
         or coalesce(m ->> 'id', '') !~ '^[a-z0-9_]{2,32}$'
         or char_length(coalesce(m ->> 'label', '')) not between 1 and 60
         or jsonb_typeof(m -> 'fields') <> 'array'
         or jsonb_array_length(m -> 'fields') not between 1 and 6
         or exists (
           select 1 from jsonb_array_elements(m -> 'fields') f
           where coalesce(f ->> 'key', '') !~ '^[a-z0-9_]{1,32}$'
              or char_length(coalesce(f ->> 'label', '')) not between 1 and 60
         )
    ) or (select count(distinct m ->> 'id') from jsonb_array_elements(p_value) m) <> jsonb_array_length(p_value) then
      raise exception 'setting_invalid';
    end if;
  else
    raise exception 'setting_unknown';
  end if;

  select value into v_before from public.app_settings where key = p_key;
  insert into public.app_settings (key, value, updated_at, updated_by)
  values (p_key, p_value, now(), auth.uid())
  on conflict (key) do update set value = excluded.value, updated_at = now(), updated_by = auth.uid()
  returning * into v_after;
  perform public._audit('setting.set', 'app_settings', p_key,
    jsonb_build_object('value', v_before), jsonb_build_object('value', p_value));
  return v_after;
end $$;

-- For admin operations performed by edge functions (e.g. registering the Telegram webhook).
create function public.admin_record_action(p_action text, p_details jsonb default null) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform public._assert_admin();
  if coalesce(p_action, '') !~ '^[a-z_.]{3,64}$' then
    raise exception 'action_invalid';
  end if;
  perform public._audit(p_action, null, null, null, p_details);
end $$;

-- Health alerts from the health function (service role).
create function public.notify_admins(p_kind text, p_body text, p_dedupe text default null) returns void
language sql security definer set search_path = '' as $$
  select public._notify_admins(p_kind, p_body, p_dedupe)
$$;

grant execute on function public.admin_list_accounts(text, text) to authenticated;
grant execute on function public.admin_set_account_status(uuid, text, text) to authenticated;
grant execute on function public.admin_set_commission(uuid, numeric) to authenticated;
grant execute on function public.admin_set_link_disabled(uuid, boolean, text) to authenticated;
grant execute on function public.admin_mark_payment_settled(uuid, text) to authenticated;
grant execute on function public.admin_run_daily_settlement(date) to authenticated;
grant execute on function public.admin_mark_statement_paid(uuid) to authenticated;
grant execute on function public.admin_decide_withdrawal(uuid, text, text, text) to authenticated;
grant execute on function public.admin_upsert_domain(text, text, boolean) to authenticated;
grant execute on function public.admin_set_setting(text, jsonb) to authenticated;
grant execute on function public.admin_record_action(text, jsonb) to authenticated;
grant execute on function public.notify_admins(text, text, text) to service_role;
