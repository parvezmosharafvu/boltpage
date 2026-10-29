-- 0008_telegram: connect flow (one-time 15-minute code -> t.me deeplink -> /start <code>)
-- and the outbox claim/complete pair used by telegram-notify.

-- Pending users may connect too, so they hear about approval.
create function public.create_telegram_link_code()
returns table (code text, deeplink text, expires_at timestamptz)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_bot text := public._setting_text('telegram_bot_username');
  v_code text := encode(sha256(convert_to(gen_random_uuid()::text || clock_timestamp()::text, 'UTF8')), 'hex');
  v_expires timestamptz := now() + interval '15 minutes';
begin
  if not exists (
    select 1 from public.profiles where id = auth.uid() and account_status in ('pending', 'active')
  ) then
    raise exception 'account_not_active' using errcode = '42501';
  end if;
  if v_bot = '' then
    raise exception 'telegram_not_configured';
  end if;
  v_code := left(v_code, 24);
  update public.profiles
     set telegram_link_code = v_code, telegram_link_expires_at = v_expires
   where id = auth.uid();
  return query select v_code, 'https://t.me/' || v_bot || '?start=' || v_code, v_expires;
end $$;

create function public.disconnect_telegram() returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.profiles
     set telegram_chat_id = null, telegram_link_code = null, telegram_link_expires_at = null
   where id = auth.uid();
end $$;

-- Service role (telegram-webhook). Returns 'linked' | 'expired' | 'invalid'.
create function public.telegram_link_chat(p_code text, p_chat_id bigint, p_username text default null)
returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_profile public.profiles;
  v_user text := nullif(regexp_replace(coalesce(p_username, ''), '^@+', ''), '');
begin
  if coalesce(p_code, '') !~ '^[0-9a-f]{24}$' or p_chat_id is null then
    return 'invalid';
  end if;
  select * into v_profile from public.profiles where telegram_link_code = p_code for update;
  if not found then
    return 'invalid';
  end if;
  if v_profile.telegram_link_expires_at is null or v_profile.telegram_link_expires_at < now() then
    update public.profiles set telegram_link_code = null, telegram_link_expires_at = null where id = v_profile.id;
    return 'expired';
  end if;

  -- A chat belongs to one account at a time.
  update public.profiles set telegram_chat_id = null where telegram_chat_id = p_chat_id and id <> v_profile.id;
  update public.profiles
     set telegram_chat_id = p_chat_id,
         telegram_link_code = null,
         telegram_link_expires_at = null,
         telegram_username = coalesce(
           telegram_username,
           case when v_user ~ '^[A-Za-z0-9_]{5,32}$' then v_user end
         )
   where id = v_profile.id;
  return 'linked';
end $$;

create function public.telegram_unlink_chat(p_chat_id bigint) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  update public.profiles set telegram_chat_id = null where telegram_chat_id = p_chat_id;
  return found;
end $$;

-- Claims up to p_limit queued messages (and ones stuck in 'sending' for 5 minutes).
create function public.claim_notifications(p_limit integer default 50)
returns setof public.notification_outbox
language sql security definer set search_path = '' as $$
  update public.notification_outbox o
     set status = 'sending', attempts = o.attempts + 1, locked_at = now()
   where o.id in (
     select n.id from public.notification_outbox n
      where (n.status = 'queued' or (n.status = 'sending' and n.locked_at < now() - interval '5 minutes'))
        and n.attempts < 5
      order by n.id
      limit greatest(1, least(p_limit, 200))
      for update skip locked
   )
  returning o.*
$$;

-- p_retry = false for permanent errors (bot blocked, chat gone): fail without retrying.
create function public.complete_notification(
  p_id bigint, p_ok boolean, p_error text default null, p_retry boolean default true
) returns void
language sql security definer set search_path = '' as $$
  update public.notification_outbox
     set status = case when p_ok then 'sent' when not p_retry or attempts >= 5 then 'failed' else 'queued' end,
         sent_at = case when p_ok then now() end,
         last_error = case when p_ok then null else left(p_error, 500) end,
         locked_at = null
   where id = p_id
$$;

grant execute on function public.create_telegram_link_code() to authenticated;
grant execute on function public.disconnect_telegram() to authenticated;
grant execute on function public.telegram_link_chat(text, bigint, text) to service_role;
grant execute on function public.telegram_unlink_chat(bigint) to service_role;
grant execute on function public.claim_notifications(integer) to service_role;
grant execute on function public.complete_notification(bigint, boolean, text, boolean) to service_role;
