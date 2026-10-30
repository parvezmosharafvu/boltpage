-- 0010: admin overview, monthly user report, statement management, admin-issued invoices,
-- payout-method enable flag, and a guard so admins cannot lock themselves out with MFA.

-- ---------------------------------------------------------------------------
-- Admin-issued invoices carry a memo for the payer and who issued them.
-- ---------------------------------------------------------------------------
alter table public.payments
  add column memo text check (memo is null or char_length(memo) <= 140),
  add column issued_by uuid references public.profiles (id);

drop function public.record_invoice(uuid, numeric, bigint, numeric, text, text, integer, text);

create function public.record_invoice(
  p_link_id uuid,
  p_amount_usd numeric,
  p_amount_sats bigint,
  p_btc_usd_rate numeric,
  p_payment_hash text,
  p_bolt11 text,
  p_expiry_seconds integer,
  p_domain text default null,
  p_memo text default null,
  p_issued_by uuid default null
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid;
  v_pct numeric;
  v_commission numeric;
  v_id uuid;
begin
  select l.user_id, coalesce(p.commission_pct, public._setting_num('default_commission_pct'))
    into v_user, v_pct
  from public.payment_links l
  join public.profiles p on p.id = l.user_id
  where l.id = p_link_id;
  if not found then
    raise exception 'link_not_found';
  end if;

  v_commission := round(p_amount_usd * v_pct / 100, 2);

  insert into public.payments (
    link_id, user_id, amount_usd, amount_sats, btc_usd_rate, commission_pct, commission_usd, net_usd,
    payment_hash, bolt11, expires_at, domain, memo, issued_by
  ) values (
    p_link_id, v_user, p_amount_usd, p_amount_sats, round(p_btc_usd_rate, 2), v_pct, v_commission,
    p_amount_usd - v_commission, lower(p_payment_hash), p_bolt11,
    now() + make_interval(secs => least(3600, greatest(60, p_expiry_seconds))),
    nullif(left(lower(btrim(coalesce(p_domain, ''))), 253), ''),
    nullif(left(btrim(coalesce(p_memo, '')), 140), ''),
    p_issued_by
  )
  returning id into v_id;
  return v_id;
end $$;

grant execute on function public.record_invoice(uuid, numeric, bigint, numeric, text, text, integer, text, text, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Statements: payout reference and admin note.
-- ---------------------------------------------------------------------------
alter table public.daily_invoices
  add column payout_reference text check (payout_reference is null or char_length(payout_reference) <= 120),
  add column admin_note text check (admin_note is null or char_length(admin_note) <= 500);

-- Creates (or regenerates) one user's statement for one cycle, even with zero payments.
create function public.admin_create_statement(p_user uuid, p_cycle_date date) returns public.daily_invoices
language plpgsql security definer set search_path = '' as $$
declare
  v_start timestamptz;
  v_end timestamptz;
  v_row public.daily_invoices;
begin
  perform public._assert_admin();
  if p_cycle_date is null then
    raise exception 'invalid_cycle_date';
  end if;
  if p_cycle_date > public._cycle_date_for(now()) then
    raise exception 'cycle_in_future';
  end if;
  if not exists (select 1 from public.profiles where id = p_user) then
    raise exception 'not_found';
  end if;
  select cycle_start, cycle_end into v_start, v_end from public._cycle_bounds(p_cycle_date);

  insert into public.daily_invoices as d (
    user_id, cycle_date, cycle_start, cycle_end, payment_count, gross_usd, commission_usd, net_usd, status, generated_at
  )
  select p_user, p_cycle_date, v_start, v_end, count(p.id), coalesce(sum(p.amount_usd), 0),
         coalesce(sum(p.commission_usd), 0), coalesce(sum(p.net_usd), 0),
         case when now() >= v_end then 'closed' else 'open' end, now()
  from public.payments p
  where p.user_id = p_user and p.status = 'settled' and p.settled_at >= v_start and p.settled_at < v_end
  on conflict (user_id, cycle_date) do update
     set payment_count = excluded.payment_count,
         gross_usd = excluded.gross_usd,
         commission_usd = excluded.commission_usd,
         net_usd = excluded.net_usd,
         generated_at = excluded.generated_at,
         status = case when d.status = 'paid_out' then 'paid_out' else excluded.status end
  returning * into v_row;

  perform public._audit('statement.create', 'daily_invoices', v_row.id::text, null, to_jsonb(v_row));
  return v_row;
end $$;

-- Status changes on a statement: closed -> paid_out (reference required), paid_out -> closed
-- (reopen, note required). Amounts are never edited here.
create function public.admin_update_statement(
  p_statement uuid, p_status text default null, p_reference text default null, p_note text default null
) returns public.daily_invoices
language plpgsql security definer set search_path = '' as $$
declare
  v_before public.daily_invoices;
  v_after public.daily_invoices;
  v_ref text := nullif(btrim(coalesce(p_reference, '')), '');
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  perform public._assert_admin();
  select * into v_before from public.daily_invoices where id = p_statement for update;
  if not found then
    raise exception 'not_found';
  end if;

  if p_status is not null and p_status <> v_before.status then
    if p_status = 'paid_out' and v_before.status = 'closed' then
      if v_ref is null then
        raise exception 'reference_required';
      end if;
    elsif p_status = 'closed' and v_before.status = 'paid_out' then
      if v_note is null then
        raise exception 'reason_required';
      end if;
    else
      raise exception 'statement_wrong_state';
    end if;
  end if;

  update public.daily_invoices
     set status = coalesce(p_status, status),
         payout_reference = case
           when p_status = 'paid_out' then v_ref
           when p_status = 'closed' then null
           else coalesce(v_ref, payout_reference)
         end,
         admin_note = coalesce(v_note, admin_note)
   where id = p_statement
  returning * into v_after;

  perform public._audit('statement.update', 'daily_invoices', p_statement::text,
    jsonb_build_object('status', v_before.status, 'payout_reference', v_before.payout_reference, 'admin_note', v_before.admin_note),
    jsonb_build_object('status', v_after.status, 'payout_reference', v_after.payout_reference, 'admin_note', v_after.admin_note),
    v_note);
  return v_after;
end $$;

-- ---------------------------------------------------------------------------
-- Admin overview: revenue (gross, incl. commission), commission, what is owed to users.
-- "Today" is the current 19:00 Dhaka cycle; "month" is the Dhaka calendar month.
-- ---------------------------------------------------------------------------
create function public.admin_overview() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_cycle date := public._cycle_date_for(now());
  v_cs timestamptz;
  v_ms timestamptz := date_trunc('month', now() at time zone 'Asia/Dhaka') at time zone 'Asia/Dhaka';
  v_out jsonb;
begin
  perform public._assert_admin();
  select cycle_start into v_cs from public._cycle_bounds(v_cycle);

  select jsonb_build_object(
    'cycle_date', v_cycle,
    'cycle_start', v_cs,
    'month_start', v_ms,
    'today', (
      select jsonb_build_object('count', count(*), 'gross_usd', coalesce(sum(amount_usd), 0),
             'commission_usd', coalesce(sum(commission_usd), 0), 'net_usd', coalesce(sum(net_usd), 0))
      from public.payments where status = 'settled' and settled_at >= v_cs),
    'month', (
      select jsonb_build_object('count', count(*), 'gross_usd', coalesce(sum(amount_usd), 0),
             'commission_usd', coalesce(sum(commission_usd), 0), 'net_usd', coalesce(sum(net_usd), 0))
      from public.payments where status = 'settled' and settled_at >= v_ms),
    'all_time', (
      select jsonb_build_object('count', count(*), 'gross_usd', coalesce(sum(amount_usd), 0),
             'commission_usd', coalesce(sum(commission_usd), 0), 'net_usd', coalesce(sum(net_usd), 0))
      from public.payments where status = 'settled'),
    -- Still owed to users: settled net minus withdrawals actually paid out.
    'payable_usd',
      (select coalesce(sum(net_usd), 0) from public.payments where status = 'settled')
      - (select coalesce(sum(amount_usd), 0) from public.withdrawals where status = 'paid'),
    'withdrawals_open', (
      select jsonb_build_object('count', count(*), 'amount_usd', coalesce(sum(amount_usd), 0))
      from public.withdrawals where status in ('requested', 'approved')),
    'attempts_month', (
      select jsonb_build_object(
        'settled', count(*) filter (where status = 'settled'),
        'expired', count(*) filter (where status = 'expired'),
        'failed', count(*) filter (where status = 'failed'),
        'pending', count(*) filter (where status = 'pending'))
      from public.payments where created_at >= v_ms),
    'users', (
      select jsonb_build_object(
        'active', count(*) filter (where account_status = 'active'),
        'pending', count(*) filter (where account_status = 'pending'),
        'blocked', count(*) filter (where account_status in ('rejected', 'suspended')))
      from public.profiles),
    'links', (
      select jsonb_build_object('active', count(*) filter (where is_active and not disabled_by_admin), 'total', count(*))
      from public.payment_links),
    'outstanding_statements', (
      select jsonb_build_object('count', count(*), 'net_usd', coalesce(sum(net_usd), 0))
      from public.daily_invoices where status = 'closed'),
    'outstanding_invoices', (
      select jsonb_build_object('count', count(*), 'amount_usd', coalesce(sum(amount_usd), 0))
      from public.payments where status = 'pending' and expires_at > now()),
    'daily', (
      select coalesce(jsonb_agg(d order by d.cycle_date), '[]'::jsonb) from (
        select public._cycle_date_for(settled_at) as cycle_date, count(*) as count,
               sum(amount_usd) as gross_usd, sum(commission_usd) as commission_usd
        from public.payments
        where status = 'settled' and settled_at >= v_cs - interval '29 days'
        group by 1) d),
    'top_users', (
      select coalesce(jsonb_agg(u order by u.gross_usd desc), '[]'::jsonb) from (
        select p.user_id, pr.email, pr.full_name, count(*) as count,
               sum(p.amount_usd) as gross_usd, sum(p.commission_usd) as commission_usd
        from public.payments p join public.profiles pr on pr.id = p.user_id
        where p.status = 'settled' and p.settled_at >= v_ms
        group by p.user_id, pr.email, pr.full_name
        order by sum(p.amount_usd) desc
        limit 5) u)
  ) into v_out;
  return v_out;
end $$;

-- ---------------------------------------------------------------------------
-- Monthly report for the logged-in user (Dhaka calendar month; null = current month).
-- ---------------------------------------------------------------------------
create function public.my_report(p_month date default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_month date := date_trunc('month', coalesce(p_month, (now() at time zone 'Asia/Dhaka')::date))::date;
  v_ms timestamptz := v_month::timestamp at time zone 'Asia/Dhaka';
  v_me timestamptz := (v_month + interval '1 month') at time zone 'Asia/Dhaka';
  v_out jsonb;
begin
  perform public._assert_active();
  select jsonb_build_object(
    'month', v_month,
    'month_start', v_ms,
    'month_end', v_me,
    'totals', (
      select jsonb_build_object('count', count(*), 'gross_usd', coalesce(sum(amount_usd), 0),
             'commission_usd', coalesce(sum(commission_usd), 0), 'net_usd', coalesce(sum(net_usd), 0))
      from public.payments
      where user_id = v_uid and status = 'settled' and settled_at >= v_ms and settled_at < v_me),
    'attempts', (
      select jsonb_build_object(
        'settled', count(*) filter (where status = 'settled'),
        'expired', count(*) filter (where status = 'expired'),
        'failed', count(*) filter (where status = 'failed'),
        'pending', count(*) filter (where status = 'pending'))
      from public.payments where user_id = v_uid and created_at >= v_ms and created_at < v_me),
    'daily', (
      select coalesce(jsonb_agg(d order by d.cycle_date), '[]'::jsonb) from (
        select public._cycle_date_for(settled_at) as cycle_date, count(*) as count,
               sum(amount_usd) as gross_usd, sum(net_usd) as net_usd
        from public.payments
        where user_id = v_uid and status = 'settled' and settled_at >= v_ms and settled_at < v_me
        group by 1) d),
    'top_links', (
      select coalesce(jsonb_agg(t order by t.gross_usd desc), '[]'::jsonb) from (
        select l.slug, l.display_name, count(*) as count, sum(p.amount_usd) as gross_usd, sum(p.net_usd) as net_usd
        from public.payments p join public.payment_links l on l.id = p.link_id
        where p.user_id = v_uid and p.status = 'settled' and p.settled_at >= v_ms and p.settled_at < v_me
        group by l.slug, l.display_name
        order by sum(p.amount_usd) desc
        limit 5) t),
    'recent', (
      select coalesce(jsonb_agg(r order by r.settled_at desc), '[]'::jsonb) from (
        select p.id, p.settled_at, p.amount_usd, p.net_usd, l.slug, p.memo
        from public.payments p join public.payment_links l on l.id = p.link_id
        where p.user_id = v_uid and p.status = 'settled' and p.settled_at >= v_ms and p.settled_at < v_me
        order by p.settled_at desc
        limit 10) r)
  ) into v_out;
  return v_out;
end $$;

-- ---------------------------------------------------------------------------
-- Payout methods can be disabled without deleting them ("enabled": false).
-- ---------------------------------------------------------------------------
create or replace function public._payout_method(p_method text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select m from jsonb_array_elements(coalesce(public._setting('payout_methods'), '[]'::jsonb)) m
  where m ->> 'id' = p_method and coalesce((m ->> 'enabled')::boolean, true)
  limit 1
$$;

create or replace function public.my_app_config() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_pct numeric;
begin
  perform public._assert_active();
  select coalesce(commission_pct, public._setting_num('default_commission_pct')) into v_pct
  from public.profiles where id = auth.uid();
  return jsonb_build_object(
    'min_usd', public._setting_num('min_usd'),
    'max_usd', public._setting_num('max_usd'),
    'quick_amounts_default', public._setting('quick_amounts_default'),
    'max_links_per_user', public._setting_num('max_links_per_user'),
    'withdrawal_min_usd', public._setting_num('withdrawal_min_usd'),
    'payout_methods', (
      select coalesce(jsonb_agg(m), '[]'::jsonb)
      from jsonb_array_elements(coalesce(public._setting('payout_methods'), '[]'::jsonb)) m
      where coalesce((m ->> 'enabled')::boolean, true)),
    'telegram_bot_username', public._setting_text('telegram_bot_username'),
    'commission_pct', v_pct
  );
end $$;

-- ---------------------------------------------------------------------------
-- Extra settings rules, enforced on every write path:
--  * an admin can only switch admin_require_mfa on from an aal2 (TOTP-verified) session,
--    so nobody locks themselves out of the admin panel;
--  * payout methods: "enabled" must be boolean and field keys unique within a method.
-- ---------------------------------------------------------------------------
create function public._app_settings_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.key = 'admin_require_mfa' and new.value = 'true'::jsonb
     and exists (select 1 from public.profiles where id = auth.uid() and role = 'admin')
     and coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' then
    raise exception 'mfa_required_first';
  end if;
  if new.key = 'payout_methods' and jsonb_typeof(new.value) = 'array' and exists (
    select 1 from jsonb_array_elements(new.value) m
    where (m ? 'enabled' and jsonb_typeof(m -> 'enabled') <> 'boolean')
       or (jsonb_typeof(m -> 'fields') = 'array'
           and (select count(distinct f ->> 'key') from jsonb_array_elements(m -> 'fields') f)
               <> jsonb_array_length(m -> 'fields'))
  ) then
    raise exception 'setting_invalid';
  end if;
  return new;
end $$;

create trigger app_settings_guard before insert or update on public.app_settings
  for each row execute function public._app_settings_guard();

grant execute on function public.admin_create_statement(uuid, date) to authenticated;
grant execute on function public.admin_update_statement(uuid, text, text, text) to authenticated;
grant execute on function public.admin_overview() to authenticated;
grant execute on function public.my_report(date) to authenticated;
