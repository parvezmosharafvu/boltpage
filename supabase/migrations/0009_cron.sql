-- 0009_cron: schedules. Skipped automatically where pg_cron/pg_net are unavailable
-- (plain Postgres in CI). Function URLs and the cron secret are read from Supabase Vault
-- at run time, never stored in git:
--   select vault.create_secret('https://<project-ref>.supabase.co', 'project_url');
--   select vault.create_secret('<CRON_SECRET>', 'cron_secret');

create function public._invoke_function(p_name text) returns bigint
language plpgsql security definer set search_path = '' as $$
declare
  v_url text;
  v_secret text;
begin
  execute 'select decrypted_secret from vault.decrypted_secrets where name = $1' into v_url using 'project_url';
  execute 'select decrypted_secret from vault.decrypted_secrets where name = $1' into v_secret using 'cron_secret';
  if v_url is null or v_secret is null then
    raise warning 'vault secrets project_url / cron_secret are not set; skipping %', p_name;
    return null;
  end if;
  return net.http_post(
    url := v_url || '/functions/v1/' || p_name,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', v_secret),
    body := '{}'::jsonb,
    timeout_milliseconds := 55000
  );
end $$;

do $cron$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron')
     and exists (select 1 from pg_available_extensions where name = 'pg_net') then
    create extension if not exists pg_cron;
    create extension if not exists pg_net with schema extensions;

    -- 19:05 Asia/Dhaka = 13:05 UTC. Also regenerates the cycle before, to absorb late settlements.
    perform cron.schedule('daily-settlement', '5 13 * * *',
      $job$select public.generate_daily_invoices(public._cycle_date_for(now()) - 1);
           select public.generate_daily_invoices(public._cycle_date_for(now()) - 2);$job$);
    perform cron.schedule('lnd-watcher', '* * * * *', $job$select public._invoke_function('lnd-watcher')$job$);
    perform cron.schedule('telegram-notify', '* * * * *', $job$select public._invoke_function('telegram-notify')$job$);
    perform cron.schedule('health', '*/5 * * * *', $job$select public._invoke_function('health')$job$);
    perform cron.schedule('housekeeping', '17 * * * *', $job$select public._housekeeping()$job$);
  else
    raise notice 'pg_cron/pg_net not available: schedules not created';
  end if;
end
$cron$;
