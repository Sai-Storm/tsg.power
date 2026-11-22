-- ============================================================================
-- Job profitability, advance overview, reminders and multiple receipts.
-- Runs after 10_money_logic.test.sql and reuses its fixtures.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Multiple receipts per expense
-- ---------------------------------------------------------------------------
select tests.login('00000000-0000-0000-0000-0000000000b1');
select public.save_advance_draft('00000000-0000-0000-0000-0000000000e3',
  '{"description":"Cable ties","amount":10000,"date":"2026-10-05","receipt_files":["a.pdf","b.jpg"]}');
select tests.eq('first receipt becomes the main receipt',
  (select receipt_file from public.expenses where description = 'Cable ties'), 'a.pdf');
select tests.eq('all receipts are kept',
  (select cardinality(receipt_files) from public.expenses where description = 'Cable ties'), 2);
select public.save_advance_draft('00000000-0000-0000-0000-0000000000e3', jsonb_build_object(
  'id', (select id from public.expenses where description = 'Cable ties'),
  'description', 'Cable ties', 'amount', 10000, 'receipt_files', jsonb_build_array('c.png'), 'remove_receipts', jsonb_build_array('a.pdf')));
select tests.eq('editing adds and removes receipts',
  (select receipt_files from public.expenses where description = 'Cable ties'), array['b.jpg', 'c.png']);
select tests.eq('main receipt follows the list',
  (select receipt_file from public.expenses where description = 'Cable ties'), 'b.jpg');
select tests.eq('advance window lists every receipt',
  (select jsonb_array_length(e->'receipt_files') from jsonb_array_elements(public.advance_expenses('00000000-0000-0000-0000-0000000000e3')->'entries') e
   where e->>'description' = 'Cable ties'), 2);

-- ---------------------------------------------------------------------------
-- 2. Job profitability
-- ---------------------------------------------------------------------------
-- Job d1: revenue 500,000 (one issued invoice, 200,000 collected)
-- Costs:  approved advance expenses 300,000 + 400,000 + 150,000 = 850,000
--         materials issued 10 x 1,000 - returned 2 x 1,000     =   8,000
-- Margin: 500,000 - 858,000 = -358,000
insert into public.inventory_items (id, sku, name, cost_price, qty_on_hand)
values ('00000000-0000-0000-0000-000000000101', 'TEST-BRG', 'Bearing', 1000, 100);
insert into public.stock_movements (item_id, job_id, type, quantity) values
  ('00000000-0000-0000-0000-000000000101', '00000000-0000-0000-0000-0000000000d1', 'issue', 10),
  ('00000000-0000-0000-0000-000000000101', '00000000-0000-0000-0000-0000000000d1', 'return', 2);

select tests.login('00000000-0000-0000-0000-0000000000b1');
select tests.throws('staff cannot view job profitability', $q$select public.job_profitability(null, null)$q$, 'administrator');

select tests.login('00000000-0000-0000-0000-0000000000a1');
create temp table profit as
select j from jsonb_array_elements(public.job_profitability(null, null)) j where j->>'id' = '00000000-0000-0000-0000-0000000000d1';
select tests.eq('job revenue = issued invoices', (select (j->>'revenue')::numeric from profit), 500000::numeric);
select tests.eq('job collected = payments received', (select (j->>'collected')::numeric from profit), 200000::numeric);
select tests.eq('job expenses = approved expenses only (rejected excluded)', (select (j->>'expenses')::numeric from profit), 850000::numeric);
select tests.eq('job materials = issued minus returned at cost', (select (j->>'materials')::numeric from profit), 8000::numeric);
select tests.eq('job margin = revenue - costs', (select (j->>'margin')::numeric from profit), -358000::numeric);
select tests.eq('job open advances counts the unsettled advance', (select (j->>'open_advances')::numeric from profit), 50000::numeric);
select tests.eq('period filter excludes jobs outside the range',
  (select count(*) from jsonb_array_elements(public.job_profitability('2000-01-01', '2000-01-31'))), 0::bigint);

-- ---------------------------------------------------------------------------
-- 3. Advance overview
-- ---------------------------------------------------------------------------
create temp table overview as select public.advance_overview() as o;
select tests.eq('money held by staff = released minus approved expenses',
  (select (o->>'held_by_staff')::numeric from overview), 50000::numeric);
select tests.ok('overdue list contains the advance past its due date',
  (select exists (select 1 from jsonb_array_elements(o->'overdue') x where x->>'id' = '00000000-0000-0000-0000-0000000000e3') from overview));
select tests.eq('pending approval stage counts the new staff request',
  (select (x->>'count')::int from overview, jsonb_array_elements(o->'stages') x where x->>'status' = 'Pending Approval'), 1);

-- ---------------------------------------------------------------------------
-- 4. Reminders (at most one per advance per day)
-- ---------------------------------------------------------------------------
select tests.ok('reminders are sent for overdue advances', public.send_advance_reminders() >= 1);
select tests.eq('sending again the same day adds nothing', public.send_advance_reminders(), 0);
select tests.eq('the staff member received the overdue reminder',
  (select count(*) from public.notifications where user_id = '00000000-0000-0000-0000-0000000000b1' and title = 'Advance settlement overdue'), 1::bigint);
