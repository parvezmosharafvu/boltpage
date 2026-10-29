-- Test helpers (schema "tests", never part of the app). Applied once, not rolled back.
create schema if not exists tests;
grant usage on schema tests to anon, authenticated, service_role;

create or replace function tests.ok(p_cond boolean, p_msg text) returns void
language plpgsql as $$
begin
  if not coalesce(p_cond, false) then
    raise exception 'FAIL: %', p_msg;
  end if;
end $$;

create or replace function tests.eq_num(p_actual numeric, p_expected numeric, p_msg text) returns void
language plpgsql as $$
begin
  if p_actual is distinct from p_expected then
    raise exception 'FAIL: % (expected %, got %)', p_msg, p_expected, p_actual;
  end if;
end $$;

create or replace function tests.eq_text(p_actual text, p_expected text, p_msg text) returns void
language plpgsql as $$
begin
  if p_actual is distinct from p_expected then
    raise exception 'FAIL: % (expected %, got %)', p_msg, p_expected, p_actual;
  end if;
end $$;

-- Runs p_sql and requires it to fail with a message matching p_pattern (case-insensitive regex).
create or replace function tests.expect_error(p_sql text, p_pattern text) returns void
language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    if sqlerrm !~* p_pattern then
      raise exception 'FAIL: expected error /%/ but got "%" from: %', p_pattern, sqlerrm, p_sql;
    end if;
    return;
  end;
  raise exception 'FAIL: expected error /%/ but statement succeeded: %', p_pattern, p_sql;
end $$;

-- Creates an auth user (firing the signup trigger). Non-null status/role are then set as
-- postgres; pass nulls to keep what the signup trigger produced.
create or replace function tests.create_user(
  p_email text, p_status text default 'active', p_role text default 'user', p_meta jsonb default '{}'::jsonb
) returns uuid
language plpgsql as $$
declare
  v_id uuid;
begin
  insert into auth.users (email, raw_user_meta_data) values (p_email, p_meta) returning id into v_id;
  update public.profiles
     set account_status = coalesce(p_status, account_status), role = coalesce(p_role, role)
   where id = v_id;
  return v_id;
end $$;

-- Named ids kept in transaction-local settings, readable from any role.
create or replace function tests.set_id(p_name text, p_id uuid) returns uuid
language sql as $$
  select set_config('t.' || p_name, p_id::text, true)::uuid
$$;

create or replace function tests.id(p_name text) returns uuid
language sql stable as $$
  select current_setting('t.' || p_name)::uuid
$$;

-- Back to the migration owner (postgres) inside the same transaction.
create or replace function tests.as_owner() returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '', true);
end $$;

-- Switch the session to a PostgREST-like role for the rest of the transaction.
create or replace function tests.as_user(p_id uuid, p_aal text default 'aal1') returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_id, 'role', 'authenticated', 'aal', p_aal)::text, true);
  perform set_config('role', 'authenticated', true);
end $$;

create or replace function tests.as_anon() returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
  perform set_config('role', 'anon', true);
end $$;

create or replace function tests.as_service() returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  perform set_config('role', 'service_role', true);
end $$;

-- Inserts a payment directly (as postgres) for tests that need settled history.
create or replace function tests.add_payment(
  p_user uuid, p_link uuid, p_amount numeric, p_status text, p_settled_at timestamptz default null,
  p_pct numeric default 5
) returns uuid
language plpgsql as $$
declare
  v_id uuid;
  v_comm numeric := round(p_amount * p_pct / 100, 2);
begin
  insert into public.payments (link_id, user_id, amount_usd, amount_sats, btc_usd_rate, commission_pct,
    commission_usd, net_usd, payment_hash, bolt11, status, expires_at, settled_at)
  values (p_link, p_user, p_amount, 1000, 50000, p_pct, v_comm, p_amount - v_comm,
    encode(sha256(convert_to(gen_random_uuid()::text, 'UTF8')), 'hex'), 'lnbc1test', p_status,
    now() + interval '1 hour', case when p_status = 'settled' then coalesce(p_settled_at, now()) end)
  returning id into v_id;
  return v_id;
end $$;

grant execute on all functions in schema tests to anon, authenticated, service_role;
