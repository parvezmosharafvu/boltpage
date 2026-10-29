-- Admin RPC validation and audit coverage.
begin;

select tests.set_id('admin', tests.create_user('admin@test.local', 'active', 'admin'));
select tests.set_id('u', tests.create_user('seller@test.local'));
select tests.as_user(tests.id('u'));
select tests.set_id('link', (public.save_my_link(null, 'seller', 'Seller')).id);
reset role;
select tests.set_id('pay', tests.add_payment(tests.id('u'), tests.id('link'), 42, 'pending'));

select tests.as_user(tests.id('u'));
select tests.expect_error($$select public.admin_set_setting('checkout_enabled', 'true')$$, 'not_authorized');
select tests.eq_num((select count(*) from public.audit_log), 0, 'users cannot read the audit log');
select tests.eq_num((select count(*) from public.app_settings), 0, 'users cannot read raw settings');
reset role;

select tests.as_user(tests.id('admin'));
-- Settings validation.
select tests.expect_error($$select public.admin_set_setting('nope', '1')$$, 'setting_unknown');
select tests.expect_error($$select public.admin_set_setting('min_usd', '0')$$, 'setting_invalid');
select tests.expect_error($$select public.admin_set_setting('min_usd', '"10"')$$, 'setting_invalid');
select tests.expect_error($$select public.admin_set_setting('max_usd', '5')$$, 'setting_invalid');
select tests.expect_error($$select public.admin_set_setting('invoice_expiry_seconds', '7200')$$, 'setting_invalid');
select tests.expect_error($$select public.admin_set_setting('default_commission_pct', '101')$$, 'setting_invalid');
select tests.expect_error($$select public.admin_set_setting('checkout_enabled', '1')$$, 'setting_invalid');
select tests.expect_error($$select public.admin_set_setting('payout_methods', '[{"id": "Bad Id", "label": "x", "fields": []}]')$$, 'setting_invalid');
select tests.expect_error($$select public.admin_set_setting('payout_methods', '[{"id": "a1", "label": "A", "fields": [{"key": "k", "label": "K"}]}, {"id": "a1", "label": "B", "fields": [{"key": "k", "label": "K"}]}]')$$, 'setting_invalid');
select public.admin_set_setting('checkout_enabled', 'true');
select public.admin_set_setting('max_usd', '500');
select public.admin_set_setting('payout_methods', '[{"id": "wallet_a", "label": "Wallet A", "fields": [{"key": "account", "label": "Account"}]}]');
select tests.eq_num((select (value #>> '{}')::numeric from public.app_settings where key = 'max_usd'), 500, 'max_usd updated');

-- Domains.
select tests.expect_error($$select public.admin_upsert_domain('Bad Host!', 'x', true)$$, 'hostname_invalid');
select public.admin_upsert_domain('PAY.Example.org', 'Main', true);
select tests.ok((select is_active from public.site_domains where hostname = 'pay.example.org'), 'domain stored lowercase');

-- Links.
select tests.expect_error(format($$select public.admin_set_link_disabled(%L, true)$$, tests.id('link')), 'reason_required');
select public.admin_set_link_disabled(tests.id('link'), true, 'Abuse report');

-- Manual settle: reason required, amounts untouched.
select tests.expect_error(format($$select public.admin_mark_payment_settled(%L, 'x')$$, tests.id('pay')), 'reason_required');
select public.admin_mark_payment_settled(tests.id('pay'), 'Reconciled with node logs');
select tests.expect_error(format($$select public.admin_mark_payment_settled(%L, 'second time')$$, tests.id('pay')), 'payment_not_settleable');
select tests.ok(
  (select status = 'settled' and settle_source = 'admin' and amount_usd = 42 and net_usd = 39.90
   from public.payments where id = tests.id('pay')),
  'manual settle keeps amounts');

-- Admin can read everything.
select tests.ok((select count(*) from public.payments) = 1, 'admin reads payments');
select tests.ok((select count(*) from public.profiles) = 2, 'admin reads profiles');
reset role;

select tests.ok(
  (select array_agg(distinct action order by action) from public.audit_log where actor_id = tests.id('admin'))
    @> array['domain.upsert', 'link.disable', 'payment.mark_settled', 'setting.set'],
  'admin writes are audited');
select tests.ok(
  (select bool_and(before is not null or after is not null) from public.audit_log),
  'audit rows carry before/after');

rollback;
