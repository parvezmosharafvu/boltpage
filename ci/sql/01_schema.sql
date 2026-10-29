-- Acceptance 1: fresh DB, schema invariants, settings seed.
begin;

select tests.ok(
  not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity
  ),
  'RLS is enabled on every public table');

select tests.ok(
  not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosecdef
      and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')
  ),
  'every SECURITY DEFINER function pins search_path');

select tests.ok(
  not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and data_type in ('real', 'double precision')
  ),
  'no float columns anywhere');

select tests.ok(
  not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'profiles' and column_name like '%balance%'
  ),
  'no stored balance column');

select tests.eq_num(public._setting_num('min_usd'), 10, 'min_usd seeded');
select tests.eq_num(public._setting_num('max_usd'), 1000, 'max_usd seeded');
select tests.eq_num(public._setting_num('invoice_expiry_seconds'), 3600, 'invoice expiry seeded');
select tests.ok(public._setting_bool('checkout_enabled') = false, 'checkout_enabled defaults to false');
select tests.ok(public._setting_bool('withdrawal_auto_approve_enabled') = false, 'auto-approve off by default');

select tests.eq_text(public._cycle_date_for(timestamptz '2026-03-10 12:59:00+00')::text, '2026-03-10', '18:59 Dhaka');
select tests.eq_text(public._cycle_date_for(timestamptz '2026-03-10 13:00:00+00')::text, '2026-03-11', '19:00 Dhaka starts next cycle');
select tests.ok(
  (select cycle_start = timestamptz '2026-03-09 13:00:00+00' and cycle_end = timestamptz '2026-03-10 13:00:00+00'
   from public._cycle_bounds(date '2026-03-10')),
  'cycle bounds are 19:00 -> 19:00 Dhaka (13:00 UTC)');

rollback;
