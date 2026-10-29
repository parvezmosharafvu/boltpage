-- Acceptance 11 (DB side): one-time codes, expiry, settlement enqueues a message.
begin;

select tests.set_id('u', tests.create_user('seller@test.local'));
select tests.set_id('p', tests.create_user('pending@test.local', null, null));

select tests.as_user(tests.id('u'));
select tests.expect_error($$select * from public.create_telegram_link_code()$$, 'telegram_not_configured');
reset role;
update public.app_settings set value = '"boltpage_test_bot"' where key = 'telegram_bot_username';

select tests.as_user(tests.id('u'));
select set_config('t.code', (select code from public.create_telegram_link_code()), true);
select tests.ok(
  (select deeplink = 'https://t.me/boltpage_test_bot?start=' || code
          and expires_at between now() + interval '14 minutes' and now() + interval '15 minutes'
   from public.create_telegram_link_code()),
  'deeplink format and 15 minute validity');
reset role;
-- The second call replaced the first code: the first is now invalid.
select tests.as_service();
select tests.eq_text(public.telegram_link_chat(current_setting('t.code'), 777, 'seller_tg'), 'invalid', 'old code replaced');
reset role;

select tests.as_user(tests.id('u'));
select set_config('t.code', (select code from public.create_telegram_link_code()), true);
reset role;
select tests.as_service();
select tests.eq_text(public.telegram_link_chat(current_setting('t.code'), 777, 'seller_tg'), 'linked', 'valid code links');
select tests.eq_text(public.telegram_link_chat(current_setting('t.code'), 777, 'seller_tg'), 'invalid', 'code is single use');
select tests.eq_text(public.telegram_link_chat('not-a-code', 777, null), 'invalid', 'garbage refused');
reset role;
select tests.ok(
  (select telegram_chat_id = 777 and telegram_link_code is null and telegram_username = 'seller_tg'
   from public.profiles where id = tests.id('u')),
  'chat linked and code cleared');

-- Expired code is refused.
select tests.as_user(tests.id('p'));
select set_config('t.code2', (select code from public.create_telegram_link_code()), true);
reset role;
update public.profiles set telegram_link_expires_at = now() - interval '1 minute' where id = tests.id('p');
select tests.as_service();
select tests.eq_text(public.telegram_link_chat(current_setting('t.code2'), 888, null), 'expired', 'expired code refused');
reset role;
select tests.ok((select telegram_chat_id is null from public.profiles where id = tests.id('p')), 'not linked');

-- Users cannot call the service-only RPCs.
select tests.as_user(tests.id('u'));
select tests.expect_error($$select public.telegram_link_chat('x', 1, null)$$, 'permission denied');
select tests.expect_error($$select * from public.claim_notifications(10)$$, 'permission denied');
reset role;

-- A settled payment enqueues a message; prefs can switch it off.
select tests.as_user(tests.id('u'));
select tests.set_id('link', (public.save_my_link(null, 'seller', 'Seller')).id);
reset role;
select tests.as_service();
select public.record_invoice(tests.id('link'), 10, 15000, 66666.67, repeat('e', 64), 'lnbc1e', 3600);
select public.settle_payment(repeat('e', 64), now(), 15000, 'watcher');
reset role;
select tests.ok(
  exists (select 1 from public.notification_outbox
          where kind = 'payment_settled' and chat_id = 777 and body like '%$10.00%/seller%'),
  'settlement message queued for linked chat');

select tests.as_user(tests.id('u'));
select public.update_my_profile('Seller', null, null, '{"payment": false}');
reset role;
select tests.as_service();
select public.record_invoice(tests.id('link'), 11, 15000, 66666.67, repeat('f', 64), 'lnbc1f', 3600);
select public.settle_payment(repeat('f', 64), now(), 15000, 'watcher');
reset role;
select tests.eq_num(
  (select count(*) from public.notification_outbox where kind = 'payment_settled' and chat_id = 777),
  1, 'payment notifications off -> nothing queued');

-- Outbox claim/complete.
select tests.as_service();
select tests.eq_num((select count(*) from public.claim_notifications(10)), 1, 'claims queued message');
select tests.eq_num((select count(*) from public.claim_notifications(10)), 0, 'claimed messages are not re-claimed');
select public.complete_notification((select id from public.notification_outbox where chat_id = 777), true);
reset role;
select tests.eq_text((select status from public.notification_outbox where chat_id = 777), 'sent', 'marked sent');

-- /stop unlinks.
select tests.as_service();
select tests.ok(public.telegram_unlink_chat(777), 'unlink');
reset role;
select tests.ok((select telegram_chat_id is null from public.profiles where id = tests.id('u')), 'chat removed');

rollback;
