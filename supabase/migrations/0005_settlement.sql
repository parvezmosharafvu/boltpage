-- 0005_settlement: daily statements per 19:00 -> 19:00 Asia/Dhaka cycle.

-- Upserts one row per user with settled payments in the cycle. Idempotent: running it
-- twice (cron + admin "Run now") yields the same rows. NULL means the most recently
-- completed cycle. A paid_out statement keeps its status.
create function public.generate_daily_invoices(p_cycle_date date default null) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_date date := coalesce(p_cycle_date, public._cycle_date_for(now()) - 1);
  v_start timestamptz;
  v_end timestamptz;
  v_status text;
  v_rows integer;
  r record;
begin
  select * into v_start, v_end from public._cycle_bounds(v_date);
  v_status := case when now() >= v_end then 'closed' else 'open' end;

  insert into public.daily_invoices as d (
    user_id, cycle_date, cycle_start, cycle_end, payment_count, gross_usd, commission_usd, net_usd,
    status, generated_at
  )
  select p.user_id, v_date, v_start, v_end, count(*), sum(p.amount_usd), sum(p.commission_usd),
         sum(p.net_usd), v_status, now()
  from public.payments p
  where p.status = 'settled' and p.settled_at >= v_start and p.settled_at < v_end
  group by p.user_id
  on conflict (user_id, cycle_date) do update
     set payment_count = excluded.payment_count,
         gross_usd = excluded.gross_usd,
         commission_usd = excluded.commission_usd,
         net_usd = excluded.net_usd,
         generated_at = excluded.generated_at,
         status = case when d.status = 'paid_out' then 'paid_out' else excluded.status end;
  get diagnostics v_rows = row_count;

  for r in
    update public.daily_invoices
       set notified_at = now()
     where cycle_date = v_date and status = 'closed' and notified_at is null
    returning user_id, payment_count, gross_usd, commission_usd, net_usd
  loop
    perform public._notify_user(
      r.user_id,
      'daily_statement',
      format('Daily statement %s: %s payments, gross $%s, commission $%s, net $%s.',
             v_date, r.payment_count, r.gross_usd, r.commission_usd, r.net_usd),
      'statement:' || r.user_id::text || ':' || v_date::text
    );
  end loop;

  return v_rows;
end $$;

-- Statements for the dashboard: the live current cycle (computed on the fly) followed by
-- generated statements for the previous p_days cycles.
create function public.my_daily_invoices(p_days integer default 30)
returns table (
  id uuid, cycle_date date, cycle_start timestamptz, cycle_end timestamptz, payment_count integer,
  gross_usd numeric, commission_usd numeric, net_usd numeric, status text, live boolean
)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_uid uuid := auth.uid();
  v_cur date := public._cycle_date_for(now());
  v_start timestamptz;
  v_end timestamptz;
begin
  perform public._assert_active();
  select * into v_start, v_end from public._cycle_bounds(v_cur);
  return query
  select null::uuid, v_cur, v_start, v_end, count(*)::integer,
         coalesce(sum(p.amount_usd), 0), coalesce(sum(p.commission_usd), 0), coalesce(sum(p.net_usd), 0),
         'open'::text, true
  from public.payments p
  where p.user_id = v_uid and p.status = 'settled' and p.settled_at >= v_start and p.settled_at < v_end
  union all
  select d.id, d.cycle_date, d.cycle_start, d.cycle_end, d.payment_count,
         d.gross_usd, d.commission_usd, d.net_usd, d.status, false
  from public.daily_invoices d
  where d.user_id = v_uid
    and d.cycle_date < v_cur
    and d.cycle_date >= v_cur - greatest(1, least(coalesce(p_days, 30), 366))
  order by 2 desc;
end $$;

create function public.my_top_links(p_days integer default 30)
returns table (link_id uuid, slug text, display_name text, payment_count bigint, gross_usd numeric, net_usd numeric)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
begin
  perform public._assert_active();
  return query
  select l.id, l.slug, l.display_name, count(p.id), coalesce(sum(p.amount_usd), 0), coalesce(sum(p.net_usd), 0)
  from public.payment_links l
  join public.payments p on p.link_id = l.id
   and p.status = 'settled'
   and p.settled_at >= now() - make_interval(days => greatest(1, least(coalesce(p_days, 30), 366)))
  where l.user_id = auth.uid()
  group by l.id
  order by 6 desc
  limit 10;
end $$;

grant execute on function public.my_daily_invoices(integer) to authenticated;
grant execute on function public.my_top_links(integer) to authenticated;
grant execute on function public.generate_daily_invoices(date) to service_role;
