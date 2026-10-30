-- 0011_vault_cron_secret: the cron secret is generated inside the database (Vault) and never leaves
-- it. pg_cron sends it as x-cron-secret (0009); functions without a CRON_SECRET function secret
-- check the header through cron_secret_matches(), callable by the service role only.
-- Plain Postgres (CI) has no Vault: the function then always answers false.

create function public.cron_secret_matches(p_secret text) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  v_secret text;
begin
  if coalesce(p_secret, '') = '' or to_regclass('vault.decrypted_secrets') is null then
    return false;
  end if;
  execute 'select decrypted_secret from vault.decrypted_secrets where name = $1' into v_secret using 'cron_secret';
  return v_secret is not null and v_secret = p_secret;
end $$;

revoke all on function public.cron_secret_matches(text) from public, anon, authenticated;
grant execute on function public.cron_secret_matches(text) to service_role;

do $vault$
declare
  v_exists boolean;
begin
  if to_regclass('vault.secrets') is null then
    return;
  end if;
  execute 'select exists (select 1 from vault.secrets where name = $1)' into v_exists using 'cron_secret';
  if not v_exists then
    execute $sql$select vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'cron_secret',
                                            'x-cron-secret for pg_cron -> Edge Functions (0011)')$sql$;
  end if;
end $vault$;
