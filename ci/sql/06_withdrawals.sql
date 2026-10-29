-- Acceptance 10: withdrawals cannot exceed balance; reject restores; every admin action audited.
-- (Concurrent requests are covered with two real connections in tests/db/concurrency.test.mjs.)
begin;

select tests.set_id('admin', tests.create_user('admin@test.local', 'active', 'admin'));
update public.profiles set telegram_chat_id = 5005 where id = tests.id('admin');
select tests.set_id('u', tests.create_user('seller@test.local'));
select tests.as_user(tests.id('u'));
select tests.set_id('link', (public.save_my_link(null, 'seller', 'Seller')).id);
reset role;
select tests.add_payment(tests.id('u'), tests.id('link'), 100, 'settled');  -- net 95.00

update public.app_settings
   set value = '[{"id": "wallet_a", "label": "Wallet A", "fields": [{"key": "account", "label": "Account"}]}]'
 where key = 'payout_methods';

select tests.as_user(tests.id('u'));
select tests.expect_error($$select public.save_payout_destination(null, 'nope', 'Main', '{"account": "1"}')$$, 'payout_method_unavailable');
select tests.expect_error($$select public.save_payout_destination(null, 'wallet_a', 'Main', '{}')$$, 'details_invalid');
select tests.expect_error($$select public.save_payout_destination(null, 'wallet_a', 'Main', '{"account": "1", "x": "y"}')$$, 'details_invalid');
select tests.set_id('dest', (public.save_payout_destination(null, 'wallet_a', 'Main', '{"account": "12345"}')).id);
select tests.expect_error(format($$select public.request_withdrawal(95.01, %L)$$, tests.id('dest')), 'insufficient_balance');
select tests.expect_error(format($$select public.request_withdrawal(10, %L)$$, tests.id('dest')), 'withdrawal_below_min');
select tests.expect_error(format($$select public.request_withdrawal(20.001, %L)$$, tests.id('dest')), 'amount_invalid');
select tests.expect_error($$select public.request_withdrawal(20, gen_random_uuid())$$, 'destination_not_found');
select tests.set_id('w1', (public.request_withdrawal(50, tests.id('dest'))).id);
select tests.expect_error(format($$select public.request_withdrawal(20, %L)$$, tests.id('dest')), 'withdrawal_in_progress');
select tests.eq_num((select available_usd from public.my_balance()), 45, 'requested amount is held');
select tests.expect_error($$update public.withdrawals set status = 'paid'$$, 'permission denied');
select tests.expect_error($$insert into public.withdrawals (user_id, amount_usd, method, destination_snapshot) values (auth.uid(), 1, 'x', '{}')$$, 'permission denied');
reset role;
select tests.ok(
  (select destination_snapshot -> 'details' ->> 'account' = '12345' and status = 'requested'
   from public.withdrawals where id = tests.id('w1')),
  'destination snapshotted');
select tests.ok(
  exists (select 1 from public.notification_outbox where kind = 'withdrawal_request' and chat_id = 5005),
  'admin notified of the request');

-- Reject (reason required) restores availability.
select tests.as_user(tests.id('admin'));
select tests.expect_error(format($$select public.admin_decide_withdrawal(%L, 'reject')$$, tests.id('w1')), 'reason_required');
select tests.expect_error(format($$select public.admin_decide_withdrawal(%L, 'paid', 'ref')$$, tests.id('w1')), 'withdrawal_wrong_state');
select public.admin_decide_withdrawal(tests.id('w1'), 'reject', null, 'Wrong account');
reset role;
select tests.as_user(tests.id('u'));
select tests.eq_num((select available_usd from public.my_balance()), 95, 'reject restores availability');

-- Full balance: request -> approve -> paid.
select tests.set_id('w2', (public.request_withdrawal(95, tests.id('dest'))).id);
reset role;
select tests.as_user(tests.id('admin'));
select public.admin_decide_withdrawal(tests.id('w2'), 'approve');
select tests.expect_error(format($$select public.admin_decide_withdrawal(%L, 'paid')$$, tests.id('w2')), 'reference_required');
select public.admin_decide_withdrawal(tests.id('w2'), 'paid', 'TX-001');
reset role;
select tests.as_user(tests.id('u'));
select tests.eq_num((select available_usd from public.my_balance()), 0, 'paid out');
select tests.expect_error(format($$select public.request_withdrawal(20, %L)$$, tests.id('dest')), 'insufficient_balance');
reset role;

select tests.eq_num(
  (select count(*) from public.audit_log
   where actor_id = tests.id('admin') and action in ('withdrawal.reject', 'withdrawal.approve', 'withdrawal.paid')),
  3, 'every admin withdrawal action audited');
select tests.ok(
  (select status = 'paid' and reference = 'TX-001' and paid_at is not null and admin_id = tests.id('admin')
   from public.withdrawals where id = tests.id('w2')),
  'paid withdrawal recorded');

-- Optional auto-approve below a threshold.
select tests.add_payment(tests.id('u'), tests.id('link'), 100, 'settled');
update public.app_settings set value = 'true' where key = 'withdrawal_auto_approve_enabled';
update public.app_settings set value = '30' where key = 'withdrawal_auto_approve_below_usd';
select tests.as_user(tests.id('u'));
select tests.eq_text((select (public.request_withdrawal(25, tests.id('dest'))).status), 'approved', 'auto-approved');
reset role;

rollback;
