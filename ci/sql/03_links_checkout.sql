-- Acceptance 4 (amount limits, link narrowing) and 12 (domains, DB side).
begin;

select tests.set_id('u', tests.create_user('seller@test.local'));
select tests.set_id('u2', tests.create_user('other@test.local'));

select tests.as_user(tests.id('u'));
select tests.set_id('shop', (public.save_my_link(null, 'shop', 'Seller Shop', 'Thanks!')).id);
select tests.set_id('narrow', (public.save_my_link(null, 'narrow', 'Narrow', null, 20, 200)).id);

-- Slug rules.
select tests.expect_error($$select public.save_my_link(null, 'admin', 'x')$$, 'slug_reserved');
select tests.expect_error($$select public.save_my_link(null, 'dashboard', 'x')$$, 'slug_reserved');
select tests.expect_error($$select public.save_my_link(null, 'ab', 'x')$$, 'slug_invalid');
select tests.expect_error($$select public.save_my_link(null, 'bad slug', 'x')$$, 'slug_invalid');
select tests.expect_error($$select public.save_my_link(null, 'a--b', 'x')$$, 'slug_invalid');
select tests.expect_error($$select public.save_my_link(null, '-abc', 'x')$$, 'slug_invalid');
select tests.expect_error($$select public.save_my_link(null, 'shop', 'x')$$, 'slug_taken');
select tests.eq_text((select (public.save_my_link(null, 'MiXeD-Case', 'x')).slug), 'mixed-case', 'slug lowercased');
select tests.expect_error($$select public.save_my_link(null, 'okay', '')$$, 'display_name_invalid');

-- A link may narrow but never widen the global range.
select tests.expect_error($$select public.save_my_link(null, 'wide1', 'x', null, 5, null)$$, 'link_min_out_of_range');
select tests.expect_error($$select public.save_my_link(null, 'wide2', 'x', null, null, 2000)$$, 'link_max_out_of_range');
select tests.expect_error($$select public.save_my_link(null, 'wide3', 'x', null, 300, 200)$$, 'link_min_above_max');
select tests.expect_error($$select public.save_my_link(null, 'wide4', 'x', null, 10.005, null)$$, 'link_min_out_of_range');

-- Another user cannot edit my link.
reset role;
select tests.as_user(tests.id('u2'));
select tests.expect_error(format($$select public.save_my_link(%L, 'stolen', 'x')$$, tests.id('shop')), 'not_found');
reset role;

-- Public lookup returns only public fields with effective limits.
select tests.as_anon();
select tests.ok(
  (select min_usd = 10 and max_usd = 1000 and display_name = 'Seller Shop' and note = 'Thanks!'
          and quick_amounts = '{10,25,50,100,250,500}'::numeric[]
   from public.public_link_by_slug('shop')),
  'public lookup: global limits and default chips');
select tests.ok(
  (select min_usd = 20 and max_usd = 200 and quick_amounts = '{25,50,100}'::numeric[]
   from public.public_link_by_slug('NARROW')),
  'public lookup: narrowed limits, chips filtered to range');
select tests.ok(
  not exists (
    select 1 from public.public_link_by_slug('shop') r, jsonb_object_keys(to_jsonb(r)) k
    where k in ('user_id', 'email', 'id', 'phone')
  ),
  'public lookup exposes no private fields');
select tests.expect_error($$select * from public.payment_links$$, 'permission denied');
select tests.expect_error($$select * from public.prepare_checkout('shop', 10)$$, 'permission denied');
reset role;

-- Server-side amount validation (service role, as create-invoice uses it).
select tests.as_service();
select tests.expect_error($$select * from public.prepare_checkout('shop', 10)$$, 'checkout_disabled');
reset role;
update public.app_settings set value = 'true' where key = 'checkout_enabled';
select tests.as_service();
select tests.expect_error($$select * from public.prepare_checkout('shop', 9.99)$$, 'amount_below_min');
select tests.expect_error($$select * from public.prepare_checkout('shop', 1000.01)$$, 'amount_above_max');
select tests.expect_error($$select * from public.prepare_checkout('shop', 10.001)$$, 'amount_invalid');
select tests.expect_error($$select * from public.prepare_checkout('shop', 0)$$, 'amount_invalid');
select tests.expect_error($$select * from public.prepare_checkout('nope', 10)$$, 'link_not_found');
select tests.eq_num((select amount_usd from public.prepare_checkout('shop', 10)), 10, '$10 accepted');
select tests.eq_num((select amount_usd from public.prepare_checkout('shop', 1000)), 1000, '$1000 accepted');
select tests.eq_num((select expiry_seconds from public.prepare_checkout('shop', 10)), 3600, 'expiry 3600');
select tests.expect_error($$select * from public.prepare_checkout('narrow', 19.99)$$, 'amount_below_min');
select tests.expect_error($$select * from public.prepare_checkout('narrow', 200.01)$$, 'amount_above_max');
select tests.eq_num((select amount_usd from public.prepare_checkout('narrow', 20)), 20, 'link min accepted');
select tests.eq_num((select amount_usd from public.prepare_checkout('narrow', 200)), 200, 'link max accepted');
reset role;

-- Expiry is clamped to 3600 even if the setting were raised directly in the table.
update public.app_settings set value = '7200' where key = 'invoice_expiry_seconds';
select tests.eq_num((select expiry_seconds from public.prepare_checkout('shop', 10)), 3600, 'expiry clamped');

-- Inactive link, admin-disabled link and suspended owner all disappear publicly.
update public.payment_links set is_active = false where id = tests.id('narrow');
select tests.eq_num((select count(*) from public.public_link_by_slug('narrow')), 0, 'inactive link hidden');
update public.payment_links set is_active = true, disabled_by_admin = true where id = tests.id('narrow');
select tests.eq_num((select count(*) from public.public_link_by_slug('narrow')), 0, 'admin-disabled link hidden');
update public.payment_links set disabled_by_admin = false where id = tests.id('narrow');
update public.profiles set account_status = 'suspended' where id = tests.id('u');
select tests.eq_num((select count(*) from public.public_link_by_slug('shop')), 0, 'suspended owner hides links');
update public.profiles set account_status = 'active' where id = tests.id('u');

-- Acceptance 12 (DB side): link resolves on every active domain only.
insert into public.site_domains (hostname, label, is_active) values
  ('pay.example.com', 'Main', true), ('pay.example.net', 'Alt', true), ('old.example.org', 'Retired', false);
select tests.as_anon();
select tests.eq_num((select count(*) from public.public_link_by_slug('shop', 'pay.example.com')), 1, 'active domain 1');
select tests.eq_num((select count(*) from public.public_link_by_slug('shop', 'PAY.EXAMPLE.NET')), 1, 'active domain 2');
select tests.eq_num((select count(*) from public.public_link_by_slug('shop', 'old.example.org')), 0, 'inactive domain');
select tests.eq_num((select count(*) from public.public_link_by_slug('shop', 'evil.example')), 0, 'unknown domain');
select tests.expect_error($$select * from public.site_domains$$, 'permission denied');
reset role;

rollback;
