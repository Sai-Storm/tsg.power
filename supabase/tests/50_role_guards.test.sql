-- ============================================================================
-- Role guards: what each person may change when calling the API directly.
-- Runs after 10_ - 40_ and reuses their fixtures (admin a1, staff b1,
-- finance f1, job d1, invoice INV-T-1 with 200,000 received).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Expenses
-- ---------------------------------------------------------------------------
select tests.login('00000000-0000-0000-0000-0000000000b1');
set role authenticated;
select tests.throws('staff cannot create an expense that is already approved',
  $q$insert into public.expenses (category, date, amount, description, payment_source, status)
     values ('Office', current_date, 99999, 'self approved', 'Employee', 'Approved')$q$, 'starts as a draft');
insert into public.expenses (id, category, date, amount, description, payment_source, status, employee_id)
values ('00000000-0000-0000-0000-00000000aa01', 'Office', current_date, 12000, 'Printer ink', 'Employee', 'Submitted', public.current_staff_id());
select tests.throws('staff cannot approve their own expense',
  $q$update public.expenses set status = 'Approved' where id = '00000000-0000-0000-0000-00000000aa01'$q$, 'only a manager');
select tests.throws('staff cannot mark their own expense paid',
  $q$update public.expenses set status = 'Paid' where id = '00000000-0000-0000-0000-00000000aa01'$q$, 'only finance');
update public.expenses set amount = 11000 where id = '00000000-0000-0000-0000-00000000aa01';
select tests.eq('staff can still correct a submitted claim', (select amount from public.expenses where id = '00000000-0000-0000-0000-00000000aa01'), 11000::numeric);
reset role;

select tests.login('00000000-0000-0000-0000-0000000000f1');
set role authenticated;
select tests.throws('finance cannot pay an expense that was not approved',
  $q$select public.set_expense_status('00000000-0000-0000-0000-00000000aa01', 'Paid')$q$, 'only an approved expense');
select tests.throws('finance cannot approve expenses',
  $q$update public.expenses set status = 'Approved' where id = '00000000-0000-0000-0000-00000000aa01'$q$, 'only a manager');
reset role;

select tests.login('00000000-0000-0000-0000-0000000000a1');
select public.set_expense_status('00000000-0000-0000-0000-00000000aa01', 'Approved');
select tests.eq('manager approves the claim', (select status from public.expenses where id = '00000000-0000-0000-0000-00000000aa01'), 'Approved');

select tests.login('00000000-0000-0000-0000-0000000000b1');
set role authenticated;
select tests.throws('staff cannot raise an approved claim',
  $q$update public.expenses set amount = 900000 where id = '00000000-0000-0000-0000-00000000aa01'$q$, 'already approved');
reset role;

select tests.login('00000000-0000-0000-0000-0000000000f1');
select public.set_expense_status('00000000-0000-0000-0000-00000000aa01', 'Paid');
select tests.eq('finance pays the approved claim', (select status from public.expenses where id = '00000000-0000-0000-0000-00000000aa01'), 'Paid');

-- ---------------------------------------------------------------------------
-- 2. Invoices
-- ---------------------------------------------------------------------------
select tests.login('00000000-0000-0000-0000-0000000000b1');
set role authenticated;
select tests.throws('staff cannot type in a received amount',
  $q$update public.invoices set amount_received = total where number = 'INV-T-1'$q$, 'record customer payments');
select tests.throws('a new invoice cannot start with money received',
  $q$insert into public.invoices (customer_id, job_id, date, total, amount_received, status)
     values ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000d1', current_date, 1000, 1000, 'Issued')$q$, 'record customer payments');
select tests.throws('invoice total cannot drop below what was received',
  $q$update public.invoices set total = 100000 where number = 'INV-T-1'$q$, 'cannot be less than');
select public.record_invoice_payment((select id from public.invoices where number = 'INV-T-1'), '{"amount":50000}');
select tests.eq('recording a payment still updates the invoice',
  (select amount_received || ' ' || status from public.invoices where number = 'INV-T-1'), '250000.00 Partially paid');
reset role;

-- ---------------------------------------------------------------------------
-- 3. Material requests and service reports
-- ---------------------------------------------------------------------------
select tests.login('00000000-0000-0000-0000-0000000000b1');
set role authenticated;
insert into public.material_requests (id, job_id, status, created_by)
values ('00000000-0000-0000-0000-00000000aa02', '00000000-0000-0000-0000-0000000000d1', 'Pending', auth.uid());
select tests.throws('staff cannot approve their own material request',
  $q$update public.material_requests set status = 'Approved' where id = '00000000-0000-0000-0000-00000000aa02'$q$, 'only a manager');
select tests.throws('staff cannot create an approved material request',
  $q$insert into public.material_requests (job_id, status, created_by) values ('00000000-0000-0000-0000-0000000000d1', 'Issued', auth.uid())$q$, 'waits for manager');
update public.material_requests set note = 'Urgent' where id = '00000000-0000-0000-0000-00000000aa02';
select tests.eq('staff can still edit a pending request', (select note from public.material_requests where id = '00000000-0000-0000-0000-00000000aa02'), 'Urgent');
reset role;

select tests.login('00000000-0000-0000-0000-0000000000a1');
set role authenticated;
update public.material_requests set status = 'Approved' where id = '00000000-0000-0000-0000-00000000aa02';
reset role;
select tests.eq('manager approves the request', (select status from public.material_requests where id = '00000000-0000-0000-0000-00000000aa02'), 'Approved');

select tests.login('00000000-0000-0000-0000-0000000000b1');
set role authenticated;
select tests.throws('staff cannot edit an approved material request',
  $q$update public.material_requests set note = 'more' where id = '00000000-0000-0000-0000-00000000aa02'$q$, 'already approved');
select tests.throws('staff cannot approve a service report',
  $q$insert into public.service_reports (job_id, status, submitted_by) values ('00000000-0000-0000-0000-0000000000d1', 'Approved', auth.uid())$q$, 'starts as a draft');
reset role;

-- ---------------------------------------------------------------------------
-- 4. Cash entries export carries the job order
-- ---------------------------------------------------------------------------
select tests.ok('cash entries list has a job order column',
  exists (select 1 from information_schema.columns where table_name = 'v_cash_entries' and column_name = 'job_order'));
