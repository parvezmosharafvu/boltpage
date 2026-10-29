-- 0006_withdrawals: payout destinations and withdrawal requests.
-- Payout methods are admin-defined in app_settings.payout_methods, e.g.
--   [{"id": "wallet_a", "label": "Wallet A", "fields": [{"key": "account", "label": "Account number"}]}]
-- Their names are only ever shown inside the logged-in dashboard and admin panel.

create function public._payout_method(p_method text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select m from jsonb_array_elements(coalesce(public._setting('payout_methods'), '[]'::jsonb)) m
  where m ->> 'id' = p_method
  limit 1
$$;

create function public.save_payout_destination(p_id uuid, p_method text, p_label text, p_details jsonb)
returns public.payout_destinations
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_method jsonb := public._payout_method(p_method);
  v_label text := btrim(coalesce(p_label, ''));
  v_row public.payout_destinations;
begin
  perform public._assert_active();
  if v_method is null then
    raise exception 'payout_method_unavailable';
  end if;
  if char_length(v_label) not between 1 and 60 then
    raise exception 'label_invalid';
  end if;
  if p_details is null or jsonb_typeof(p_details) <> 'object' then
    raise exception 'details_invalid';
  end if;
  -- Only the method's declared fields, each a non-empty string of at most 120 chars.
  if exists (
    select 1 from jsonb_each(p_details) e
    where e.key not in (select f ->> 'key' from jsonb_array_elements(v_method -> 'fields') f)
       or jsonb_typeof(e.value) <> 'string'
       or char_length(e.value #>> '{}') > 120
  ) or exists (
    select 1 from jsonb_array_elements(v_method -> 'fields') f
    where coalesce(btrim(p_details ->> (f ->> 'key')), '') = ''
  ) then
    raise exception 'details_invalid';
  end if;

  if p_id is null then
    if (select count(*) from public.payout_destinations where user_id = v_uid) >= 10 then
      raise exception 'destination_limit_reached';
    end if;
    insert into public.payout_destinations (user_id, method, label, details)
    values (v_uid, p_method, v_label, p_details)
    returning * into v_row;
  else
    update public.payout_destinations
       set method = p_method, label = v_label, details = p_details
     where id = p_id and user_id = v_uid
    returning * into v_row;
    if not found then
      raise exception 'not_found';
    end if;
  end if;
  return v_row;
end $$;

create function public.delete_payout_destination(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform public._assert_active();
  delete from public.payout_destinations where id = p_id and user_id = auth.uid();
  if not found then
    raise exception 'not_found';
  end if;
end $$;

-- Locks the caller's profile row so concurrent requests serialize, then re-checks the
-- derived balance. The partial unique index is a second line of defence.
create function public.request_withdrawal(p_amount_usd numeric, p_destination_id uuid)
returns public.withdrawals
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_profile public.profiles;
  v_dest public.payout_destinations;
  v_available numeric;
  v_row public.withdrawals;
  v_auto boolean;
begin
  select * into v_profile from public.profiles where id = v_uid for update;
  if not found or v_profile.account_status <> 'active' then
    raise exception 'account_not_active' using errcode = '42501';
  end if;

  if p_amount_usd is null or p_amount_usd <= 0 or p_amount_usd <> round(p_amount_usd, 2) then
    raise exception 'amount_invalid';
  end if;
  if p_amount_usd < public._setting_num('withdrawal_min_usd') then
    raise exception 'withdrawal_below_min';
  end if;
  if exists (
    select 1 from public.withdrawals where user_id = v_uid and status in ('requested', 'approved')
  ) then
    raise exception 'withdrawal_in_progress';
  end if;

  select available_usd into v_available from public._balance(v_uid);
  if p_amount_usd > coalesce(v_available, 0) then
    raise exception 'insufficient_balance';
  end if;

  select * into v_dest from public.payout_destinations where id = p_destination_id and user_id = v_uid;
  if not found then
    raise exception 'destination_not_found';
  end if;
  if public._payout_method(v_dest.method) is null then
    raise exception 'payout_method_unavailable';
  end if;

  v_auto := public._setting_bool('withdrawal_auto_approve_enabled')
            and p_amount_usd <= public._setting_num('withdrawal_auto_approve_below_usd');

  insert into public.withdrawals (
    user_id, amount_usd, method, destination_id, destination_snapshot, status, decided_at, reference
  ) values (
    v_uid, p_amount_usd, v_dest.method, v_dest.id,
    jsonb_build_object('label', v_dest.label, 'method', v_dest.method, 'details', v_dest.details),
    case when v_auto then 'approved' else 'requested' end,
    case when v_auto then now() end,
    case when v_auto then 'auto-approved' end
  )
  returning * into v_row;

  if v_auto then
    perform public._audit('withdrawal.auto_approve', 'withdrawals', v_row.id::text, null, to_jsonb(v_row));
  end if;
  perform public._notify_admins(
    'withdrawal_request',
    format('Withdrawal %s: $%s by %s (%s).', v_row.status, v_row.amount_usd, v_profile.email, v_dest.method),
    'withdrawal:' || v_row.id::text
  );
  return v_row;
end $$;

grant execute on function public.save_payout_destination(uuid, text, text, jsonb) to authenticated;
grant execute on function public.delete_payout_destination(uuid) to authenticated;
grant execute on function public.request_withdrawal(numeric, uuid) to authenticated;
