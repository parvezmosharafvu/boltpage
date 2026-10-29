-- Acceptance 2 (approval gate) and 3 (profile guard).
begin;

select tests.set_id('admin', tests.create_user('admin@test.local', 'active', 'admin'));
update public.profiles set telegram_chat_id = 1001 where id = tests.id('admin');

-- Signup metadata cannot self-activate or self-promote.
select tests.set_id('alice', tests.create_user('alice@test.local', null, null,
  '{"full_name": "Alice", "phone": "+8801700000000", "telegram_username": "@alice_tg",
    "role": "admin", "account_status": "active", "commission_pct": 0}'));
select tests.ok(
  (select account_status = 'pending' and role = 'user' and commission_pct is null
          and full_name = 'Alice' and telegram_username = 'alice_tg' and email = 'alice@test.local'
   from public.profiles where id = tests.id('alice')),
  'new signup is pending/user, metadata copied, @ stripped');
select tests.ok(
  exists (select 1 from public.notification_outbox
          where kind = 'signup' and chat_id = 1001 and body like '%alice@test.local%'),
  'admin signup notification queued');

-- Pending user: own profile readable, everything else refused server-side.
select tests.as_user(tests.id('alice'));
select tests.eq_num((select count(*) from public.profiles), 1, 'pending user sees only own profile');
select tests.expect_error($$select public.save_my_link(null, 'alice', 'Alice')$$, 'account_not_active');
select tests.expect_error($$select public.request_withdrawal(20, gen_random_uuid())$$, 'account_not_active');
select tests.expect_error($$select public.my_balance()$$, 'account_not_active');
select tests.expect_error($$select public.my_overview()$$, 'account_not_active');
select tests.expect_error($$select public.my_app_config()$$, 'account_not_active');
select tests.expect_error($$select public.admin_list_accounts()$$, 'not_authorized');
select tests.eq_num((select count(*) from public.payments), 0, 'pending user reads no payments');

-- Acceptance 3: protected profile columns.
select tests.expect_error($$update public.profiles set role = 'admin' where id = auth.uid()$$, 'protected_profile_field');
select tests.expect_error($$update public.profiles set account_status = 'active' where id = auth.uid()$$, 'protected_profile_field');
select tests.expect_error($$update public.profiles set commission_pct = 0 where id = auth.uid()$$, 'protected_profile_field');
select tests.expect_error($$update public.profiles set telegram_chat_id = 42 where id = auth.uid()$$, 'protected_profile_field');
update public.profiles set full_name = 'Alice A.' where id = auth.uid();
select tests.eq_text((select full_name from public.profiles where id = auth.uid()), 'Alice A.', 'own name editable');
-- Other users' rows are invisible, so updates touch nothing.
update public.profiles set full_name = 'hacked' where id = tests.id('admin');
reset role;
select tests.eq_text((select full_name from public.profiles where id = tests.id('admin')), '', 'cannot edit others');

-- Admin approves -> user can create a link; audit + notification.
update public.profiles set telegram_chat_id = 2002 where id = tests.id('alice');
select tests.as_user(tests.id('admin'));
select tests.expect_error(format($$select public.admin_set_account_status(%L, 'active')$$, tests.id('admin')), 'cannot_change_own_status');
select public.admin_set_account_status(tests.id('alice'), 'active');
reset role;
select tests.ok(
  exists (select 1 from public.audit_log where action = 'account.set_status' and target_id = tests.id('alice')::text
          and actor_id = tests.id('admin') and after ->> 'account_status' = 'active'),
  'approval audited');
select tests.ok(
  exists (select 1 from public.notification_outbox where kind = 'account' and chat_id = 2002),
  'user approval notification queued');

select tests.as_user(tests.id('alice'));
select tests.eq_text((select (public.save_my_link(null, 'alice', 'Alice')).slug), 'alice', 'approved user creates link');
reset role;

-- Reject requires a reason, and a rejected user stays locked out.
select tests.set_id('bob', tests.create_user('bob@test.local', null, null));
select tests.as_user(tests.id('admin'));
select tests.expect_error(format($$select public.admin_set_account_status(%L, 'rejected')$$, tests.id('bob')), 'reason_required');
select public.admin_set_account_status(tests.id('bob'), 'rejected', 'Duplicate account');
reset role;
select tests.as_user(tests.id('bob'));
select tests.expect_error($$select public.save_my_link(null, 'bobby', 'Bob')$$, 'account_not_active');
reset role;

-- Suspending hides the user's own data from them.
select tests.as_user(tests.id('admin'));
select public.admin_set_account_status(tests.id('alice'), 'suspended', 'Chargeback review');
reset role;
select tests.as_user(tests.id('alice'));
select tests.eq_num((select count(*) from public.payment_links), 0, 'suspended user cannot read own links');
reset role;

-- Admin MFA: with admin_require_mfa on, an aal1 session is not an admin.
update public.app_settings set value = 'true' where key = 'admin_require_mfa';
select tests.as_user(tests.id('admin'), 'aal1');
select tests.expect_error($$select public.admin_list_accounts()$$, 'not_authorized');
reset role;
select tests.as_user(tests.id('admin'), 'aal2');
select tests.ok((select count(*) from public.admin_list_accounts()) >= 3, 'aal2 admin lists accounts');
select tests.ok((select count(*) from public.admin_list_accounts('pending')) = 0, 'filter by status');
reset role;

rollback;
