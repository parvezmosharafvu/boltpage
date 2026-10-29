-- 0004_payments: checkout validation, invoice recording with commission stamp,
-- idempotent state transitions, rate limits, derived balance.

-- ---------------------------------------------------------------------------
-- Service-only (edge functions): validate a checkout before asking LND for an invoice.
-- ---------------------------------------------------------------------------
create function public.prepare_checkout(p_slug text, p_amount_usd numeric, p_hostname text default null)
returns table (link_id uuid, user_id uuid, display_name text, amount_usd numeric, expiry_seconds integer)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_link record;
begin
  if not public._setting_bool('checkout_enabled') then
    raise exception 'checkout_disabled';
  end if;

  select l.id, l.user_id, l.display_name, pl.min_usd, pl.max_usd
    into v_link
  from public.public_link_by_slug(p_slug, p_hostname) pl
  join public.payment_links l on l.slug = pl.slug;
  if not found then
    raise exception 'link_not_found';
  end if;

  if p_amount_usd is null or p_amount_usd <= 0 or p_amount_usd <> round(p_amount_usd, 2) then
    raise exception 'amount_invalid';
  end if;
  if p_amount_usd < v_link.min_usd then
    raise exception 'amount_below_min';
  end if;
  if p_amount_usd > v_link.max_usd then
    raise exception 'amount_above_max';
  end if;

  return query
  select v_link.id, v_link.user_id, v_link.display_name, p_amount_usd,
         least(3600, greatest(60, public._setting_num('invoice_expiry_seconds')))::integer;
end $$;

-- Records the invoice LND just created. Stamps the commission % so later changes never
-- rewrite history. Deliberately does not re-check link/account status: the invoice exists
-- and must be tracked even if the link was disabled a moment ago.
create function public.record_invoice(
  p_link_id uuid,
  p_amount_usd numeric,
  p_amount_sats bigint,
  p_btc_usd_rate numeric,
  p_payment_hash text,
  p_bolt11 text,
  p_expiry_seconds integer,
  p_domain text default null
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
    payment_hash, bolt11, expires_at, domain
  ) values (
    p_link_id, v_user, p_amount_usd, p_amount_sats, round(p_btc_usd_rate, 2), v_pct, v_commission,
    p_amount_usd - v_commission, lower(p_payment_hash), p_bolt11,
    now() + make_interval(secs => least(3600, greatest(60, p_expiry_seconds))),
    nullif(left(lower(btrim(coalesce(p_domain, ''))), 253), '')
  )
  returning id into v_id;
  return v_id;
end $$;

-- Fixed-window rate limiter. Returns true when the call is allowed.
create function public.rate_limit_hit(p_bucket text, p_window_seconds integer, p_max integer)
returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_window timestamptz := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  v_hits integer;
begin
  insert into public.rate_limits as r (bucket, window_start, hits)
  values (left(p_bucket, 200), v_window, 1)
  on conflict (bucket, window_start) do update set hits = r.hits + 1
  returning hits into v_hits;
  return v_hits <= p_max;
end $$;

-- ---------------------------------------------------------------------------
-- State transitions. Each is guarded on the current status, so concurrent callers
-- (watcher + payment-status + admin) can only win once.
-- ---------------------------------------------------------------------------
create function public.settle_payment(
  p_payment_hash text, p_settled_at timestamptz, p_amt_paid_sat bigint, p_source text
) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  v_p public.payments;
  v_slug text;
begin
  -- 'expired' is included on purpose: if LND says the invoice settled, the money arrived.
  update public.payments
     set status = 'settled',
         settled_at = least(coalesce(p_settled_at, now()), now()),
         amt_paid_sat = p_amt_paid_sat,
         settle_source = p_source,
         last_checked_at = now()
   where payment_hash = lower(p_payment_hash)
     and status in ('pending', 'expired')
  returning * into v_p;
  if not found then
    return false;
  end if;

  select slug into v_slug from public.payment_links where id = v_p.link_id;
  perform public._notify_user(
    v_p.user_id,
    'payment_settled',
    format('Payment received: $%s on /%s. Net after commission: $%s.', v_p.amount_usd, v_slug, v_p.net_usd),
    'settled:' || v_p.id::text
  );
  return true;
end $$;

create function public.expire_payment(p_payment_hash text) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  update public.payments
     set status = 'expired', last_checked_at = now()
   where payment_hash = lower(p_payment_hash) and status = 'pending';
  return found;
end $$;

create function public.fail_payment(p_payment_hash text) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  update public.payments
     set status = 'failed', last_checked_at = now()
   where payment_hash = lower(p_payment_hash) and status = 'pending';
  return found;
end $$;

-- ---------------------------------------------------------------------------
-- Derived balance: settled net minus every withdrawal that was not rejected.
-- security_invoker so RLS applies to whoever queries the view.
-- ---------------------------------------------------------------------------
create view public.user_balances with (security_invoker = true) as
select p.id as user_id,
       s.settled_net_usd,
       w.withdrawn_usd,
       s.settled_net_usd - w.withdrawn_usd as available_usd
from public.profiles p
cross join lateral (
  select coalesce(sum(x.net_usd), 0)::numeric(12, 2) as settled_net_usd
  from public.payments x where x.user_id = p.id and x.status = 'settled'
) s
cross join lateral (
  select coalesce(sum(y.amount_usd), 0)::numeric(12, 2) as withdrawn_usd
  from public.withdrawals y where y.user_id = p.id and y.status <> 'rejected'
) w;

create function public._balance(p_user uuid)
returns table (settled_net_usd numeric, withdrawn_usd numeric, available_usd numeric)
language sql stable security definer set search_path = '' as $$
  select b.settled_net_usd, b.withdrawn_usd, b.available_usd
  from public.user_balances b where b.user_id = p_user
$$;

create function public.my_balance()
returns table (settled_net_usd numeric, withdrawn_usd numeric, available_usd numeric)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public._assert_active();
  return query select * from public._balance(auth.uid());
end $$;

-- Dashboard overview: balance + the current (still open) 19:00 Dhaka cycle.
create function public.my_overview() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_cycle date := public._cycle_date_for(now());
  v_start timestamptz;
  v_end timestamptz;
  v_bal record;
  v_today record;
  v_pct numeric;
begin
  perform public._assert_active();
  select * into v_start, v_end from public._cycle_bounds(v_cycle);
  select * into v_bal from public._balance(v_uid);
  select count(*) as n,
         coalesce(sum(amount_usd), 0) as gross,
         coalesce(sum(commission_usd), 0) as commission,
         coalesce(sum(net_usd), 0) as net
    into v_today
  from public.payments
  where user_id = v_uid and status = 'settled' and settled_at >= v_start and settled_at < v_end;
  select coalesce(commission_pct, public._setting_num('default_commission_pct')) into v_pct
  from public.profiles where id = v_uid;

  return jsonb_build_object(
    'available_usd', v_bal.available_usd,
    'settled_net_usd', v_bal.settled_net_usd,
    'withdrawn_usd', v_bal.withdrawn_usd,
    'cycle_date', v_cycle,
    'cycle_start', v_start,
    'cycle_end', v_end,
    'today_count', v_today.n,
    'today_gross_usd', v_today.gross,
    'today_net_usd', v_today.net,
    'cycle_commission_usd', v_today.commission,
    'commission_pct', v_pct
  );
end $$;

-- Hourly cleanup (pg_cron).
create function public._housekeeping() returns void
language sql security definer set search_path = '' as $$
  delete from public.rate_limits where window_start < now() - interval '1 day';
  delete from public.notification_outbox where status = 'sent' and sent_at < now() - interval '30 days';
  update public.profiles set telegram_link_code = null, telegram_link_expires_at = null
   where telegram_link_expires_at < now();
$$;

grant select on public.user_balances to authenticated;
grant execute on function public.my_balance() to authenticated;
grant execute on function public.my_overview() to authenticated;

grant execute on function public.prepare_checkout(text, numeric, text) to service_role;
grant execute on function public.record_invoice(uuid, numeric, bigint, numeric, text, text, integer, text) to service_role;
grant execute on function public.rate_limit_hit(text, integer, integer) to service_role;
grant execute on function public.settle_payment(text, timestamptz, bigint, text) to service_role;
grant execute on function public.expire_payment(text) to service_role;
grant execute on function public.fail_payment(text) to service_role;
