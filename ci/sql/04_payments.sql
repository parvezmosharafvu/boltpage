-- Acceptance 5 (DB side of create-invoice), 7 (idempotent transitions), 8 (commission).
begin;

select tests.set_id('admin', tests.create_user('admin@test.local', 'active', 'admin'));
select tests.set_id('u', tests.create_user('seller@test.local'));
select tests.set_id('u2', tests.create_user('other@test.local'));
update public.profiles set telegram_chat_id = 3003 where id = tests.id('u');

select tests.as_user(tests.id('u'));
select tests.set_id('link', (public.save_my_link(null, 'seller', 'Seller')).id);
reset role;
select tests.as_user(tests.id('admin'));
select public.admin_set_commission(tests.id('u'), 5);
reset role;

-- record_invoice stamps rate, sats, hash and commission.
select tests.as_service();
select tests.set_id('p1', public.record_invoice(tests.id('link'), 100, 150000, 66666.666, repeat('a', 64), 'lnbc1p1', 3600, 'Pay.Example.com'));
reset role;
select tests.ok(
  (select amount_usd = 100 and amount_sats = 150000 and btc_usd_rate = 66666.67 and commission_pct = 5
          and commission_usd = 5.00 and net_usd = 95.00 and status = 'pending' and domain = 'pay.example.com'
          and user_id = tests.id('u') and expires_at between now() + interval '3599 seconds' and now() + interval '3601 seconds'
   from public.payments where id = tests.id('p1')),
  'commission 5% of $100 -> 5.00 / 95.00, rate and expiry stored');

select tests.as_service();
select tests.set_id('p2', public.record_invoice(tests.id('link'), 33.33, 50000, 66666.67, repeat('b', 64), 'lnbc1p2', 99999));
reset role;
select tests.ok(
  (select expires_at <= now() + interval '3600 seconds' and commission_usd = 1.67 and net_usd = 31.66
   from public.payments where id = tests.id('p2')),
  'expiry clamped to 3600; commission rounds half up');

-- Changing the user's % later does not rewrite history.
select tests.as_user(tests.id('admin'));
select public.admin_set_commission(tests.id('u'), 10);
reset role;
select tests.eq_num((select commission_usd from public.payments where id = tests.id('p1')), 5.00, 'old payment keeps 5%');
select tests.as_service();
select tests.set_id('p3', public.record_invoice(tests.id('link'), 100, 150000, 66666.67, repeat('c', 64), 'lnbc1p3', 3600));
reset role;
select tests.eq_num((select commission_usd from public.payments where id = tests.id('p3')), 10.00, 'new payment uses 10%');
select tests.as_user(tests.id('admin'));
select public.admin_set_commission(tests.id('u'), null);
reset role;
select tests.as_service();
select tests.set_id('p4', public.record_invoice(tests.id('link'), 100, 150000, 66666.67, repeat('d', 64), 'lnbc1p4', 3600));
reset role;
select tests.eq_num((select commission_pct from public.payments where id = tests.id('p4')), 5, 'null commission -> default setting');

-- Settlement happens exactly once.
select tests.as_service();
select tests.ok(public.settle_payment(repeat('a', 64), now() - interval '10 seconds', 150000, 'watcher'), 'first settle wins');
select tests.ok(not public.settle_payment(repeat('a', 64), now(), 150000, 'status'), 'second settle is a no-op');
select tests.ok(not public.expire_payment(repeat('a', 64)), 'cannot expire a settled payment');
reset role;
select tests.ok(
  (select status = 'settled' and settle_source = 'watcher' and amt_paid_sat = 150000 and settled_at <= now()
   from public.payments where id = tests.id('p1')),
  'settled fields recorded');
select tests.eq_num(
  (select count(*) from public.notification_outbox where kind = 'payment_settled' and chat_id = 3003),
  1, 'exactly one settlement notification');

-- Expire, then a late SETTLED from LND still credits the user (once).
select tests.as_service();
select tests.ok(public.expire_payment(repeat('b', 64)), 'pending -> expired');
select tests.ok(not public.expire_payment(repeat('b', 64)), 'expire is idempotent');
select tests.ok(public.settle_payment(repeat('b', 64), now(), 50000, 'watcher'), 'late settle of expired invoice');
select tests.ok(public.fail_payment(repeat('c', 64)), 'pending -> failed');
select tests.ok(not public.settle_payment(repeat('c', 64), now(), 1, 'watcher'), 'failed is terminal');
reset role;

-- Derived balance.
select tests.as_user(tests.id('u'));
select tests.eq_num((select available_usd from public.my_balance()), 126.66, 'balance = 95.00 + 31.66');
select tests.eq_num((select (public.my_overview() ->> 'available_usd')::numeric), 126.66, 'overview balance');
select tests.eq_num((select available_usd from public.user_balances), 126.66, 'balance view (own row only)');
select tests.expect_error($$select public.settle_payment(repeat('d', 64), now(), 1, 'watcher')$$, 'permission denied');
select tests.expect_error($$update public.payments set status = 'settled'$$, 'permission denied');
reset role;

-- Users never see each other's payments.
select tests.as_user(tests.id('u2'));
select tests.eq_num((select count(*) from public.payments), 0, 'other user sees no payments');
select tests.eq_num((select count(*) from public.user_balances), 1, 'other user sees only own balance row');
reset role;

-- Rate limiter.
select tests.as_service();
select tests.ok(public.rate_limit_hit('ip:test', 60, 2), 'hit 1 allowed');
select tests.ok(public.rate_limit_hit('ip:test', 60, 2), 'hit 2 allowed');
select tests.ok(not public.rate_limit_hit('ip:test', 60, 2), 'hit 3 refused');
reset role;

rollback;
