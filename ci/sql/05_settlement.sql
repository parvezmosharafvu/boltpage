-- Acceptance 9: 19:00 Asia/Dhaka cycles, idempotent generation, admin "Run now".
begin;

select tests.set_id('admin', tests.create_user('admin@test.local', 'active', 'admin'));
select tests.set_id('u', tests.create_user('seller@test.local'));
update public.profiles set telegram_chat_id = 4004 where id = tests.id('u');
select tests.as_user(tests.id('u'));
select tests.set_id('link', (public.save_my_link(null, 'seller', 'Seller')).id);
reset role;

-- Cycle D ends at D 19:00 Dhaka. Use a date a few days back so the cycle is closed.
select set_config('t.d', (public._cycle_date_for(now()) - 5)::text, true);
select tests.add_payment(tests.id('u'), tests.id('link'), 100, 'settled',
  ((current_setting('t.d')::date + time '18:59') at time zone 'Asia/Dhaka'));
select tests.add_payment(tests.id('u'), tests.id('link'), 40, 'settled',
  ((current_setting('t.d')::date + time '19:01') at time zone 'Asia/Dhaka'));
select tests.add_payment(tests.id('u'), tests.id('link'), 60, 'settled',
  ((current_setting('t.d')::date - 1 + time '19:00') at time zone 'Asia/Dhaka'));
select tests.add_payment(tests.id('u'), tests.id('link'), 999, 'pending');

select tests.eq_num(public.generate_daily_invoices(current_setting('t.d')::date), 1, 'one statement for cycle D');
select tests.eq_num(public.generate_daily_invoices(current_setting('t.d')::date + 1), 1, 'one statement for cycle D+1');
select tests.ok(
  (select payment_count = 2 and gross_usd = 160 and commission_usd = 8 and net_usd = 152 and status = 'closed'
   from public.daily_invoices where user_id = tests.id('u') and cycle_date = current_setting('t.d')::date),
  '18:59 and the 19:00 cycle start are in cycle D; pending ignored');
select tests.ok(
  (select payment_count = 1 and gross_usd = 40
   from public.daily_invoices where user_id = tests.id('u') and cycle_date = current_setting('t.d')::date + 1),
  '19:01 lands in cycle D+1');

-- Idempotent: running again changes nothing and does not re-notify.
select public.generate_daily_invoices(current_setting('t.d')::date);
select public.generate_daily_invoices(current_setting('t.d')::date);
select tests.eq_num((select count(*) from public.daily_invoices where user_id = tests.id('u')), 2, 'no duplicate statements');
select tests.eq_num(
  (select count(*) from public.notification_outbox where kind = 'daily_statement' and chat_id = 4004),
  2, 'one statement-ready message per closed statement');

-- Admin "Run now" uses the same function, is audited, and is admin-only.
select tests.as_user(tests.id('u'));
select tests.expect_error(format($$select public.admin_run_daily_settlement(%L)$$, current_setting('t.d')), 'not_authorized');
reset role;
select tests.as_user(tests.id('admin'));
select tests.eq_num(public.admin_run_daily_settlement(current_setting('t.d')::date), 1, 'run now regenerates');
select public.admin_mark_statement_paid(
  (select id from public.daily_invoices where user_id = tests.id('u') and cycle_date = current_setting('t.d')::date));
select public.admin_run_daily_settlement(current_setting('t.d')::date);
reset role;
select tests.eq_text(
  (select status from public.daily_invoices where user_id = tests.id('u') and cycle_date = current_setting('t.d')::date),
  'paid_out', 'regeneration keeps paid_out');
select tests.ok(
  exists (select 1 from public.audit_log where action = 'settlement.run' and actor_id = tests.id('admin')),
  'run now audited');

-- Current cycle generated early is "open".
select public.generate_daily_invoices(public._cycle_date_for(now()));
select tests.add_payment(tests.id('u'), tests.id('link'), 25, 'settled', now());
select public.generate_daily_invoices(public._cycle_date_for(now()));
select tests.eq_text(
  (select status from public.daily_invoices where user_id = tests.id('u') and cycle_date = public._cycle_date_for(now())),
  'open', 'current cycle statement is open');

-- Dashboard view: live current cycle first, then history; top links.
select tests.as_user(tests.id('u'));
select tests.ok(
  (select live and status = 'open' and gross_usd = 25 from public.my_daily_invoices(30) limit 1),
  'my_daily_invoices starts with the live cycle');
select tests.eq_num((select count(*) from public.my_daily_invoices(30)), 3, 'live + two history rows');
select tests.ok(
  (select slug = 'seller' and payment_count = 4 and gross_usd = 225 from public.my_top_links(30)),
  'top links aggregates settled payments');
reset role;

rollback;
