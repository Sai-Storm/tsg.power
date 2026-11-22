-- ============================================================================
-- Expense claims in My advances (staff paid with their own money).
-- Runs after 10_ - 30_ and reuses their fixtures (admin a1, staff b1/b2,
-- finance f1, job d1).
-- ============================================================================

select tests.eq('database reports the claims version', public.schema_version(), '20261127000000');

-- ---------------------------------------------------------------------------
-- 1. Opening a claim
-- ---------------------------------------------------------------------------
select tests.login('00000000-0000-0000-0000-0000000000b1');
select tests.throws('a claim needs a purpose',
  $q$select public.open_expense_claim('{"purpose":"  "}')$q$, 'what this claim is for');

select public.open_expense_claim('{"purpose":"Office supplies"}')->>'id' as office_claim \gset
select public.open_expense_claim('{"purpose":"Site visit","job_id":"00000000-0000-0000-0000-0000000000d1"}')->>'id' as job_claim \gset

select tests.ok('claim is numbered CLM-',
  (select number from public.advances where id = :'office_claim') ~ '^CLM-\d{4}-\d{4}$',
  (select number from public.advances where id = :'office_claim'));
select tests.eq('claim opens in progress without approval or release',
  (select status from public.advances where id = :'office_claim'), 'Issued');
select tests.eq('claim holds no company money', (select amount from public.advances where id = :'office_claim'), 0::numeric);
select tests.eq('claim belongs to the signed-in staff member',
  (select staff_id from public.advances where id = :'office_claim'), (select id from public.staff where profile_id = '00000000-0000-0000-0000-0000000000b1' limit 1));
select tests.eq('office claim may have no job order', (select job_id from public.advances where id = :'office_claim'), null::uuid);
select tests.eq('list shows the type and Office job',
  (select type || ' / ' || job_order from public.v_advances where id = :'office_claim'), 'Claim / Office');
select tests.ok('advances still need a job order',
  (select count(*) from public.advances where kind = 'Advance' and job_id is null and deleted_at is null) = 0);

-- Staff cannot fake a claim straight into the table with money on it.
set role authenticated;
select tests.throws('staff cannot insert a claim directly',
  format($q$insert into public.advances (kind, staff_id, job_id, amount, purpose) values ('Claim', %L, null, 500000, 'x')$q$, (select id from public.staff where profile_id = '00000000-0000-0000-0000-0000000000b1' limit 1)),
  'row-level security|violates');
reset role;

-- An admin edit cannot put money on a claim or turn it into an advance.
select tests.login('00000000-0000-0000-0000-0000000000a1');
update public.advances set amount = 999999, kind = 'Advance' where id = :'office_claim';
select tests.eq('claim kind and zero amount are locked',
  (select kind || ' ' || amount from public.advances where id = :'office_claim'), 'Claim 0.00');

-- ---------------------------------------------------------------------------
-- 2. Recording expenses
-- ---------------------------------------------------------------------------
select tests.login('00000000-0000-0000-0000-0000000000b2');
select tests.throws('another staff member cannot add to my claim',
  format($q$select public.save_advance_draft(%L, '{"description":"x","amount":1}')$q$, :'office_claim'), 'not authorized');

select tests.login('00000000-0000-0000-0000-0000000000b1');
select tests.throws('expense date cannot be in the future',
  format($q$select public.save_advance_draft(%L, jsonb_build_object('description','x','amount',1,'date',current_date + 1))$q$, :'office_claim'), 'future');
select tests.throws('claims older than 90 days are refused',
  format($q$select public.save_advance_draft(%L, jsonb_build_object('description','x','amount',1,'date',current_date - 91))$q$, :'office_claim'), '90 days');

select public.save_advance_draft(:'office_claim', jsonb_build_object('description', 'Printer paper', 'amount', 45000, 'date', current_date - 2, 'receipt_file', 'paper.pdf'));
select public.save_advance_draft(:'office_claim', jsonb_build_object('description', 'Taxi to bank', 'amount', 15000, 'date', current_date - 1));
select public.save_advance_draft(:'job_claim', jsonb_build_object('description', 'Bus ticket', 'amount', 30000, 'date', current_date, 'receipt_file', 'bus.jpg'));

select tests.eq('office claim expense defaults to Office category',
  (select category from public.expenses where description = 'Printer paper'), 'Office');
select tests.eq('claim expense is paid by the employee',
  (select payment_source from public.expenses where description = 'Printer paper'), 'Employee');
select tests.eq('job claim expense is booked to the job',
  (select job_id from public.expenses where description = 'Bus ticket'), '00000000-0000-0000-0000-0000000000d1'::uuid);
select tests.eq('window knows it is a claim',
  public.advance_expenses(:'office_claim')->'advance'->>'kind', 'Claim');

select tests.throws('a missing receipt blocks submission',
  format($q$select public.submit_advance_settlement(%L, null)$q$, :'office_claim'), 'no receipt');
select public.save_advance_draft(:'office_claim', jsonb_build_object(
  'id', (select id from public.expenses where description = 'Taxi to bank'),
  'description', 'Taxi to bank', 'amount', 15000, 'date', current_date - 1, 'exception_reason', 'Street taxi, no receipt given'));
select tests.eq('receipt exception reason is shown in the window',
  (select e->>'exception_reason' from jsonb_array_elements(public.advance_expenses(:'office_claim')->'entries') e where e->>'description' = 'Taxi to bank'),
  'Street taxi, no receipt given');

-- ---------------------------------------------------------------------------
-- 3. Submit, review, pay
-- ---------------------------------------------------------------------------
select tests.eq('a written reason lets the claim be submitted',
  public.submit_advance_settlement(:'office_claim', null)->'advance'->>'status', 'Under Review');
select tests.ok('managers are told about the claim',
  exists (select 1 from public.notifications n join public.advances a on a.number = n.related_to
          where a.id = :'office_claim' and n.title = 'Expense claim submitted' and n.details like '%60,000 MMK to be reimbursed%'));
select tests.throws('a submitted claim cannot be cancelled',
  format($q$select public.cancel_expense_claim(%L)$q$, :'office_claim'), 'cannot be cancelled|can no longer');

select tests.login('00000000-0000-0000-0000-0000000000a1');
select public.review_advance_expense((select id from public.expenses where description = 'Taxi to bank'), 'Rejected', 'Use a receipt app next time');
select tests.eq('manager approves the claim',
  public.decide_advance_settlement(:'office_claim', 'approve', null)->'advance'->>'status', 'Settlement Approved');
select tests.eq('company owes the approved total',
  (public.advance_expenses(:'office_claim')->'advance'->>'net')::numeric, -45000::numeric);

select tests.login('00000000-0000-0000-0000-0000000000f1');
select tests.eq('finance pays and closes the claim',
  public.reconcile_advance(:'office_claim', '{"method":"Bank transfer","reference":"PV-77"}')->'advance'->>'status', 'Settled');
select tests.eq('reimbursement recorded', (select sum(amount) from public.advance_reimbursements where advance_id = :'office_claim'), 45000::numeric);
select tests.ok('cash book payment says expense claim',
  exists (select 1 from public.cash_entries where source_id = :'office_claim' and type = 'Payment' and amount = 45000
          and description like 'Expense claim reimbursed%'));

-- ---------------------------------------------------------------------------
-- 4. Cancelling
-- ---------------------------------------------------------------------------
select tests.login('00000000-0000-0000-0000-0000000000b2');
select tests.throws('only the owner can cancel',
  format($q$select public.cancel_expense_claim(%L)$q$, :'job_claim'), 'not authorized');
select tests.login('00000000-0000-0000-0000-0000000000b1');
select tests.eq('owner cancels a claim with only drafts',
  public.cancel_expense_claim(:'job_claim')->'advance'->>'status', 'Cancelled');
select tests.eq('its drafts are removed',
  (select count(*) from public.expenses where advance_id = :'job_claim' and deleted_at is null), 0::bigint);
select tests.throws('advances cannot be cancelled as claims',
  $q$select public.cancel_expense_claim('00000000-0000-0000-0000-0000000000e2')$q$, 'only expense claims');
