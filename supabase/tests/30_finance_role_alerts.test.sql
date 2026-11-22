-- ============================================================================
-- Finance role, separation of duties, private files, alerts, purchase
-- requests, receivables and the management report.
-- Runs after 10_ and 20_ and reuses their fixtures.
-- ============================================================================

select tests.ok('database reports its version', public.schema_version() >= '20261126000000');

-- ---------------------------------------------------------------------------
-- Fixtures: a finance user (who is also an employee) and an advance of theirs
-- ---------------------------------------------------------------------------
insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data) values
  ('00000000-0000-0000-0000-0000000000f1', 'finance@test.local', '{"name":"Fin User","role":"Finance","username":"fin"}', '{"created_by_admin":true}')
on conflict do nothing;
insert into public.profiles (id, email, username, name, role) values
  ('00000000-0000-0000-0000-0000000000f1', 'finance@test.local', 'fin', 'Fin User', 'Finance')
on conflict (id) do update set role = 'Finance', is_active = true;
insert into public.staff (name, profile_id, designation)
select 'Fin User', '00000000-0000-0000-0000-0000000000f1', 'Accountant'
where not exists (select 1 from public.staff where profile_id = '00000000-0000-0000-0000-0000000000f1');

select tests.ok('finance user has a staff record',
  exists (select 1 from public.staff where profile_id = '00000000-0000-0000-0000-0000000000f1'));

-- An advance requested by staff 1, and one by the finance user.
insert into public.advances (id, staff_id, job_id, purpose, amount, status, date)
values ('00000000-0000-0000-0000-0000000000e7', (select id from public.staff where profile_id = '00000000-0000-0000-0000-0000000000b1' limit 1), '00000000-0000-0000-0000-0000000000d1', 'Fuel', 80000, 'Pending Approval', '2026-11-01'),
       ('00000000-0000-0000-0000-0000000000e8', (select id from public.staff where profile_id = '00000000-0000-0000-0000-0000000000f1'),
        '00000000-0000-0000-0000-0000000000d1', 'Own trip', 60000, 'Pending Approval', '2026-11-01');

-- ---------------------------------------------------------------------------
-- 1. Finance may release and settle, but not approve
-- ---------------------------------------------------------------------------
select tests.login('00000000-0000-0000-0000-0000000000f1');
select tests.throws('finance cannot approve an advance request',
  $q$select public.set_advance_status('00000000-0000-0000-0000-0000000000e7', 'Approved')$q$, 'administrator');

select tests.login('00000000-0000-0000-0000-0000000000a1');
select public.set_advance_status('00000000-0000-0000-0000-0000000000e7', 'Approved');
select tests.ok('approval tells finance to release the money',
  exists (select 1 from public.notifications where user_id = '00000000-0000-0000-0000-0000000000f1' and title = 'Advance ready to release'));

select tests.login('00000000-0000-0000-0000-0000000000f1');
select public.issue_advance('00000000-0000-0000-0000-0000000000e7', '{"amount":80000,"date":"2026-11-02","method":"Cash","reference":"V-1"}');
select tests.eq('finance released the money', (select status from public.advances where id = '00000000-0000-0000-0000-0000000000e7'), 'Issued');
select tests.ok('finance can view the cash board', (public.cash_board('2026-11-01', '2026-11-30') ? 'ledger'));
select tests.ok('finance can view the advance overview', (public.advance_overview() ? 'stages'));

-- ---------------------------------------------------------------------------
-- 2. Nobody handles their own advance
-- ---------------------------------------------------------------------------
select tests.login('00000000-0000-0000-0000-0000000000a1');
select public.set_advance_status('00000000-0000-0000-0000-0000000000e8', 'Approved');
select tests.login('00000000-0000-0000-0000-0000000000f1');
select tests.throws('finance cannot release their own advance',
  $q$select public.issue_advance('00000000-0000-0000-0000-0000000000e8', '{"amount":60000,"date":"2026-11-02","method":"Cash","reference":"V-2"}')$q$,
  'your own advance');
select tests.eq('own advance stays approved', (select status from public.advances where id = '00000000-0000-0000-0000-0000000000e8'), 'Approved');

-- ---------------------------------------------------------------------------
-- 3. Private files
-- ---------------------------------------------------------------------------
select tests.eq('attachments bucket is private', (select public from storage.buckets where id = 'attachments'), false);
select tests.ok('receipt files are private', public.is_private_attachment('b.jpg'));
select tests.ok('other files are not private', not public.is_private_attachment('some-job-photo.png'));

-- ---------------------------------------------------------------------------
-- 4. Alerts are queued for people who opted in
-- ---------------------------------------------------------------------------
reset role;
update public.profiles set email_alerts = true, telegram_chat_id = '12345' where id = '00000000-0000-0000-0000-0000000000b1';
select public.notify_staff((select id from public.staff where profile_id = '00000000-0000-0000-0000-0000000000b1' limit 1), 'Test alert', 'Hello', 'T-1');
select tests.eq('email queued for an opted-in user',
  (select count(*) from public.outbound_messages where channel = 'email' and related_to = 'T-1'), 1::bigint);
select tests.eq('telegram queued for a linked chat',
  (select count(*) from public.outbound_messages where channel = 'telegram' and recipient = '12345'), 1::bigint);
select tests.eq('nothing queued for users who did not opt in',
  (select count(*) from public.outbound_messages where recipient = 'staff2@test.local'), 0::bigint);

-- ---------------------------------------------------------------------------
-- 5. Low stock -> purchase request -> received
-- ---------------------------------------------------------------------------
insert into public.inventory_items (id, sku, name, cost_price, qty_on_hand, reorder_level)
values ('00000000-0000-0000-0000-000000000102', 'TEST-FLT', 'Oil filter', 5000, 2, 5);
select tests.login('00000000-0000-0000-0000-0000000000a1');
select tests.ok('low stock lists the item',
  exists (select 1 from jsonb_array_elements(public.low_stock_items()) x where x->>'sku' = 'TEST-FLT'));
select tests.ok('daily alerts notify about low stock', public.send_daily_alerts() > 0);
select tests.eq('daily alerts are not repeated the same day',
  (select count(*) from public.notifications where title = 'Low stock' and related_to = 'TEST-FLT' and user_id = '00000000-0000-0000-0000-0000000000a1'), 1::bigint);

create temp table pr as select public.create_purchase_request('00000000-0000-0000-0000-000000000102') as r;
select tests.eq('suggested quantity fills to twice the reorder level', (select (r->>'quantity')::numeric from pr), 8::numeric);
select tests.eq('estimated cost = quantity x cost price', (select (r->>'estimated_cost')::numeric from pr), 40000::numeric);
select tests.ok('request gets a number', (select r->>'number' like 'PR-%' from pr));
select public.set_purchase_request_status((select (r->>'id')::uuid from pr), 'Received');
select tests.eq('receiving adds the stock', (select qty_on_hand from public.inventory_items where sku = 'TEST-FLT'), 10::numeric);
select tests.throws('a received request cannot change again',
  format('select public.set_purchase_request_status(%L, %L)', (select r->>'id' from pr), 'Cancelled'), 'already');

select tests.login('00000000-0000-0000-0000-0000000000b1');
select tests.throws('staff cannot create purchase requests',
  $q$select public.create_purchase_request('00000000-0000-0000-0000-000000000102')$q$, 'finance');

-- ---------------------------------------------------------------------------
-- 6. Receivables and statement
-- ---------------------------------------------------------------------------
select tests.login('00000000-0000-0000-0000-0000000000f1');
create temp table recv as select public.receivables_summary() as r;
select tests.ok('receivables list customers who owe money', (select jsonb_array_length(r) > 0 from recv));
select tests.eq('outstanding = invoice total - received for the test customer',
  (select (c->>'outstanding')::numeric from recv, jsonb_array_elements(r) c where c->>'customer' = (select name from public.customers where id = (select customer_id from public.jobs where id = '00000000-0000-0000-0000-0000000000d1'))),
  300000::numeric);
select tests.ok('statement lists invoices and payments',
  (select jsonb_array_length(public.customer_statement((select customer_id from public.jobs where id = '00000000-0000-0000-0000-0000000000d1'))->'lines') >= 2));

select tests.login('00000000-0000-0000-0000-0000000000b1');
select tests.throws('staff cannot view receivables', $q$select public.receivables_summary()$q$, 'finance');

-- ---------------------------------------------------------------------------
-- 7. Management report
-- ---------------------------------------------------------------------------
select tests.login('00000000-0000-0000-0000-0000000000a1');
create temp table mr as select public.management_report('2026-11-15') as r;
select tests.eq('report covers the whole month', (select r->>'from' from mr), '2026-11-01');
select tests.ok('report has cash, jobs and receivables', (select r ? 'cash_in' and r ? 'jobs' and r ? 'receivables' from mr));
reset role;
