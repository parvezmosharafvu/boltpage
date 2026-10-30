-- 0011: cron secret check. Without Vault (plain Postgres) it fails closed; only the service role
-- may call it.
begin;

select tests.ok(not public.cron_secret_matches('anything'), 'no Vault -> no match');
select tests.ok(not public.cron_secret_matches(''), 'empty secret never matches');
select tests.ok(not public.cron_secret_matches(null), 'null secret never matches');
select tests.ok(has_function_privilege('service_role', 'public.cron_secret_matches(text)', 'execute'), 'service role can check');
select tests.ok(not has_function_privilege('anon', 'public.cron_secret_matches(text)', 'execute'), 'anon cannot probe the secret');
select tests.ok(not has_function_privilege('authenticated', 'public.cron_secret_matches(text)', 'execute'), 'users cannot probe the secret');

rollback;
