-- 0003_links_profiles: slug rules, link CRUD, public link lookup, profile self-service.

-- Keep in sync with public/slug-rules.js (tests/unit/slug-rules.test.mjs compares them).
insert into public.reserved_slugs (slug) values
  ('404'), ('about'), ('account'), ('admin'), ('api'), ('app'), ('assets'), ('auth'), ('billing'),
  ('blog'), ('config'), ('contact'), ('dashboard'), ('docs'), ('favicon'), ('functions'), ('health'),
  ('help'), ('i18n'), ('index'), ('invoice'), ('invoices'), ('login'), ('logout'), ('mail'), ('pay'),
  ('payment'), ('payments'), ('privacy'), ('register'), ('reset'), ('rest'), ('robots'), ('root'),
  ('settings'), ('signin'), ('signout'), ('signup'), ('sitemap'), ('static'), ('status'), ('styles'),
  ('support'), ('telegram'), ('terms'), ('vendor'), ('withdraw'), ('www');

-- ---------------------------------------------------------------------------
-- Public, anon-callable: only the fields the checkout page needs.
-- ---------------------------------------------------------------------------
create function public.public_link_by_slug(p_slug text, p_hostname text default null)
returns table (
  slug text, display_name text, note text, min_usd numeric, max_usd numeric,
  quick_amounts numeric[], og_version bigint, checkout_enabled boolean
)
language sql stable security definer set search_path = '' as $$
  with g as (
    select public._setting_num('min_usd') as gmin,
           public._setting_num('max_usd') as gmax,
           public._setting_bool('checkout_enabled') as enabled
  )
  select l.slug,
         l.display_name,
         l.note,
         greatest(g.gmin, coalesce(l.min_usd, g.gmin)),
         least(g.gmax, coalesce(l.max_usd, g.gmax)),
         array(
           select q from unnest(l.quick_amounts) q
           where q between greatest(g.gmin, coalesce(l.min_usd, g.gmin)) and least(g.gmax, coalesce(l.max_usd, g.gmax))
           order by q
         ),
         extract(epoch from l.updated_at)::bigint,
         g.enabled
  from public.payment_links l
  join public.profiles p on p.id = l.user_id
  cross join g
  where l.slug = lower(btrim(p_slug))
    and l.is_active
    and not l.disabled_by_admin
    and p.account_status = 'active'
    and (
      p_hostname is null
      or exists (select 1 from public.site_domains d where d.hostname = lower(p_hostname) and d.is_active)
    )
$$;

create function public.public_checkout_config() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'min_usd', public._setting_num('min_usd'),
    'max_usd', public._setting_num('max_usd'),
    'invoice_expiry_seconds', least(3600, public._setting_num('invoice_expiry_seconds')),
    'checkout_enabled', public._setting_bool('checkout_enabled'),
    'support_contact', public._setting_text('support_contact')
  )
$$;

-- ---------------------------------------------------------------------------
-- Logged-in user: links
-- ---------------------------------------------------------------------------
create function public.save_my_link(
  p_id uuid,
  p_slug text,
  p_display_name text,
  p_note text default null,
  p_min_usd numeric default null,
  p_max_usd numeric default null,
  p_quick_amounts numeric[] default null,
  p_is_active boolean default true
) returns public.payment_links
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_slug text := lower(btrim(coalesce(p_slug, '')));
  v_name text := btrim(coalesce(p_display_name, ''));
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_gmin numeric := public._setting_num('min_usd');
  v_gmax numeric := public._setting_num('max_usd');
  v_lo numeric;
  v_hi numeric;
  v_source numeric[];
  v_quick numeric[];
  v_row public.payment_links;
begin
  perform public._assert_active();

  if v_slug !~ '^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$' or v_slug like '%--%' then
    raise exception 'slug_invalid';
  end if;
  if exists (select 1 from public.reserved_slugs r where r.slug = v_slug) then
    raise exception 'slug_reserved';
  end if;
  if char_length(v_name) not between 1 and 60 then
    raise exception 'display_name_invalid';
  end if;
  if v_note is not null and char_length(v_note) > 280 then
    raise exception 'note_too_long';
  end if;

  -- A link may narrow the global range but never widen it.
  if p_min_usd is not null and (p_min_usd <> round(p_min_usd, 2) or p_min_usd < v_gmin or p_min_usd > v_gmax) then
    raise exception 'link_min_out_of_range';
  end if;
  if p_max_usd is not null and (p_max_usd <> round(p_max_usd, 2) or p_max_usd < v_gmin or p_max_usd > v_gmax) then
    raise exception 'link_max_out_of_range';
  end if;
  if p_min_usd is not null and p_max_usd is not null and p_min_usd > p_max_usd then
    raise exception 'link_min_above_max';
  end if;
  v_lo := greatest(v_gmin, coalesce(p_min_usd, v_gmin));
  v_hi := least(v_gmax, coalesce(p_max_usd, v_gmax));

  v_source := coalesce(
    p_quick_amounts,
    array(select jsonb_array_elements_text(public._setting('quick_amounts_default'))::numeric)
  );
  if exists (select 1 from unnest(v_source) q where q is not null and q <> round(q, 2)) then
    raise exception 'quick_amount_invalid';
  end if;
  select coalesce(array_agg(distinct q order by q), '{}') into v_quick
  from unnest(v_source) q
  where q is not null and q between v_lo and v_hi;
  if cardinality(v_quick) > 8 then
    raise exception 'too_many_quick_amounts';
  end if;

  if p_id is null then
    if (select count(*) from public.payment_links where user_id = v_uid) >= public._setting_num('max_links_per_user') then
      raise exception 'link_limit_reached';
    end if;
    insert into public.payment_links (user_id, slug, display_name, note, min_usd, max_usd, quick_amounts, is_active)
    values (v_uid, v_slug, v_name, v_note, p_min_usd, p_max_usd, v_quick, coalesce(p_is_active, true))
    returning * into v_row;
  else
    update public.payment_links
       set slug = v_slug,
           display_name = v_name,
           note = v_note,
           min_usd = p_min_usd,
           max_usd = p_max_usd,
           quick_amounts = v_quick,
           is_active = coalesce(p_is_active, is_active)
     where id = p_id and user_id = v_uid
    returning * into v_row;
    if not found then
      raise exception 'not_found';
    end if;
  end if;
  return v_row;
exception
  when unique_violation then
    raise exception 'slug_taken';
end $$;

-- ---------------------------------------------------------------------------
-- Logged-in user: profile + config
-- ---------------------------------------------------------------------------
create function public.update_my_profile(
  p_full_name text,
  p_phone text,
  p_telegram_username text,
  p_notify_prefs jsonb default null
) returns public.profiles
language plpgsql security definer set search_path = '' as $$
declare
  v_tg text := nullif(regexp_replace(btrim(coalesce(p_telegram_username, '')), '^@+', ''), '');
  v_row public.profiles;
begin
  if not exists (
    select 1 from public.profiles where id = auth.uid() and account_status in ('pending', 'active')
  ) then
    raise exception 'account_not_active' using errcode = '42501';
  end if;
  if char_length(btrim(coalesce(p_full_name, ''))) not between 1 and 120 then
    raise exception 'full_name_invalid';
  end if;
  if v_tg is not null and v_tg !~ '^[A-Za-z0-9_]{5,32}$' then
    raise exception 'telegram_username_invalid';
  end if;
  if p_notify_prefs is not null and (
    jsonb_typeof(p_notify_prefs) <> 'object'
    or exists (
      select 1 from jsonb_each(p_notify_prefs) e
      where e.key not in ('payment', 'daily', 'withdrawal') or jsonb_typeof(e.value) <> 'boolean'
    )
  ) then
    raise exception 'notify_prefs_invalid';
  end if;

  update public.profiles
     set full_name = btrim(p_full_name),
         phone = nullif(left(btrim(coalesce(p_phone, '')), 32), ''),
         telegram_username = v_tg,
         notify_prefs = coalesce(notify_prefs || p_notify_prefs, notify_prefs)
   where id = auth.uid()
  returning * into v_row;
  return v_row;
end $$;

create function public.my_app_config() returns jsonb
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
    'payout_methods', public._setting('payout_methods'),
    'telegram_bot_username', public._setting_text('telegram_bot_username'),
    'commission_pct', v_pct
  );
end $$;

grant execute on function public.public_link_by_slug(text, text) to anon, authenticated;
grant execute on function public.public_checkout_config() to anon, authenticated;
grant execute on function public.save_my_link(uuid, text, text, text, numeric, numeric, numeric[], boolean) to authenticated;
grant execute on function public.update_my_profile(text, text, text, jsonb) to authenticated;
grant execute on function public.my_app_config() to authenticated;
