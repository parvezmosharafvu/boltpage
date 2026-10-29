-- 0010: admin overview, monthly report, statement management, admin invoices, payout-method
-- enable flag, MFA lock-out guard.
begin;

select tests.set_id('admin', tests.create_user('admin@test.local', 'active', 'admin'));
select tests.set_id('u', tests.create_user('seller@test.local'));
select tests.set_id('u2', tests.create_user('other@test.local'));
select tests.create_user('waiting@test.local', null, null);
select tests.as_user(tests.id('u'));
select tests.set_id('link', (public.save_my_link(null, 'seller', 'Seller')).id);
reset role;

-- This month: 2 settled ($100, $40), 1 expired, 1 failed, 1 pending (at 5%).
select tests.add_payment(tests.id('u'), tests.id('link'), 100, 'settled', now() - interval '1 minute');
select tests.add_payment(tests.id('u'), tests.id('link'), 40, 'settled', now() - interval '2 minutes');
select tests.add_payment(tests.id('u'), tests.id('link'), 25, 'expired');
select tests.add_payment(tests.id('u'), tests.id('link'), 30, 'failed');
select tests.add_payment(tests.id('u'), tests.id('link'), 50, 'pending');
insert into public.withdrawals (user_id, amount_usd, method, destination_snapshot, status)
values (tests.id('u'), 20, 'wallet_a', '{}', 'paid'), (tests.id('u'), 10, 'wallet_a', '{}', 'requested');

-- Admin overview.
select tests.as_user(tests.id('u'));
select tests.expect_error($$select public.admin_overview()$$, 'not_authorized');
reset role;
select tests.as_user(tests.id('admin'));
select set_config('t.ov', public.admin_overview()::text, true);
reset role;
select tests.eq_num((current_setting('t.ov')::jsonb #>> '{month,gross_usd}')::numeric, 140, 'month gross incl. commission');
select tests.eq_num((current_setting('t.ov')::jsonb #>> '{month,commission_usd}')::numeric, 7, 'month commission');
select tests.eq_num((current_setting('t.ov')::jsonb ->> 'payable_usd')::numeric, 113, 'payable = 133 net - 20 paid out');
select tests.eq_num((current_setting('t.ov')::jsonb #>> '{withdrawals_open,count}')::numeric, 1, 'open withdrawals');
select tests.eq_num((current_setting('t.ov')::jsonb #>> '{attempts_month,expired}')::numeric, 1, 'expired attempts');
select tests.eq_num((current_setting('t.ov')::jsonb #>> '{attempts_month,settled}')::numeric, 2, 'settled attempts');
select tests.eq_num((current_setting('t.ov')::jsonb #>> '{users,pending}')::numeric, 1, 'pending users');
select tests.eq_num((current_setting('t.ov')::jsonb #>> '{outstanding_invoices,count}')::numeric, 1, 'outstanding invoices');
select tests.eq_text((current_setting('t.ov')::jsonb #>> '{top_users,0,email}'), 'seller@test.local', 'top user');

-- Monthly report for the user; others see nothing of it.
select tests.as_user(tests.id('u'));
select set_config('t.rep', public.my_report()::text, true);
select tests.eq_num((current_setting('t.rep')::jsonb #>> '{totals,net_usd}')::numeric, 133, 'report net');
select tests.eq_num((current_setting('t.rep')::jsonb #>> '{attempts,failed}')::numeric, 1, 'report failed');
select tests.eq_num(jsonb_array_length(current_setting('t.rep')::jsonb -> 'recent'), 2, 'recent paid');
select tests.eq_text(current_setting('t.rep')::jsonb #>> '{top_links,0,slug}', 'seller', 'top link');
select tests.eq_num((public.my_report((now() - interval '2 months')::date) #>> '{totals,count}')::numeric, 0, 'other month empty');
reset role;
select tests.as_user(tests.id('u2'));
select tests.eq_num((public.my_report() #>> '{totals,count}')::numeric, 0, 'reports are per user');
reset role;

-- Statements: create for a user, mark paid out (reference), reopen (reason), audit.
select set_config('t.d', (public._cycle_date_for(now()) - 3)::text, true);
select set_config('t.future', (public._cycle_date_for(now()) + 1)::text, true);
select tests.add_payment(tests.id('u'), tests.id('link'), 60, 'settled',
  ((current_setting('t.d')::date - 1 + time '20:00') at time zone 'Asia/Dhaka'));
select tests.as_user(tests.id('admin'));
select tests.expect_error(format($$select public.admin_create_statement(%L, %L)$$, tests.id('u'), current_setting('t.future')), 'cycle_in_future');
select tests.set_id('st', (public.admin_create_statement(tests.id('u'), current_setting('t.d')::date)).id);
select tests.set_id('st0', (public.admin_create_statement(tests.id('u2'), current_setting('t.d')::date)).id);
select tests.expect_error(format($$select public.admin_update_statement(%L, 'paid_out')$$, tests.id('st')), 'reference_required');
select public.admin_update_statement(tests.id('st'), 'paid_out', 'BATCH-7');
select tests.expect_error(format($$select public.admin_update_statement(%L, 'closed')$$, tests.id('st')), 'reason_required');
select public.admin_update_statement(tests.id('st'), 'closed', null, 'Payout bounced');
select tests.expect_error(format($$select public.admin_update_statement(%L, 'open')$$, tests.id('st')), 'statement_wrong_state');
reset role;
select tests.ok(
  (select payment_count = 1 and gross_usd = 60 and status = 'closed' and payout_reference is null and admin_note = 'Payout bounced'
   from public.daily_invoices where id = tests.id('st')),
  'statement created, paid out, reopened');
select tests.ok((select payment_count = 0 and status = 'closed' from public.daily_invoices where id = tests.id('st0')), 'zero statement allowed');
select tests.eq_num(
  (select count(*) from public.audit_log where actor_id = tests.id('admin') and action in ('statement.create', 'statement.update')),
  4, 'statement actions audited');

-- Admin-issued invoice keeps memo and issuer.
select tests.as_service();
select tests.set_id('inv', public.record_invoice(tests.id('link'), 75, 110000, 68000, repeat('9', 64), 'lnbc1memo', 3600, null, 'Order #42', tests.id('admin')));
reset role;
select tests.ok((select memo = 'Order #42' and issued_by = tests.id('admin') from public.payments where id = tests.id('inv')), 'memo + issuer stored');

-- Disabled payout methods disappear for users and cannot be used.
update public.app_settings set value = '[
  {"id": "wallet_a", "label": "Wallet A", "fields": [{"key": "account", "label": "Account"}]},
  {"id": "wallet_b", "label": "Wallet B", "enabled": false, "fields": [{"key": "account", "label": "Account"}]}]'
 where key = 'payout_methods';
select tests.as_user(tests.id('u'));
select tests.eq_num(jsonb_array_length(public.my_app_config() -> 'payout_methods'), 1, 'only enabled methods shown');
select tests.expect_error($$select public.save_payout_destination(null, 'wallet_b', 'B', '{"account": "1"}')$$, 'payout_method_unavailable');
reset role;
select tests.as_user(tests.id('admin'));
select tests.expect_error($$select public.admin_set_setting('payout_methods', '[{"id": "x1", "label": "X", "enabled": "no", "fields": [{"key": "a", "label": "A"}]}]')$$, 'setting_invalid');
select tests.expect_error($$select public.admin_set_setting('payout_methods', '[{"id": "x1", "label": "X", "fields": [{"key": "a", "label": "A"}, {"key": "a", "label": "B"}]}]')$$, 'setting_invalid');

-- MFA guard: an aal1 admin cannot switch on admin_require_mfa (would lock themselves out).
select tests.expect_error($$select public.admin_set_setting('admin_require_mfa', 'true')$$, 'mfa_required_first');
reset role;
select tests.as_user(tests.id('admin'), 'aal2');
select public.admin_set_setting('admin_require_mfa', 'true');
reset role;
select tests.ok(public._setting_bool('admin_require_mfa'), 'aal2 admin enabled MFA requirement');

rollback;
