-- ============================================================================
-- Expense claims in My advances (staff paid with their own money).
-- Runs after 10_ - 30_ and reuses their fixtures (admin a1, staff b1/b2,
-- finance f1, job d1).
-- ============================================================================

select tests.ok('database reports the claims version', public.schema_version() >= '20261127000000');

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
select tests.eq('claims list shows Office for no job order',
  (select job_order from public.v_expense_claims where id = :'office_claim'), 'Office');
select tests.ok('claims are not in the advances list',
  not exists (select 1 from public.v_advances where id = :'office_claim'));
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

-- ---------------------------------------------------------------------------
-- 5. List figures
-- ---------------------------------------------------------------------------
select tests.eq('paid claim: claimed excludes the rejected expense',
  (select claimed_value from public.v_expense_claims where id = :'office_claim'), 45000::numeric);
select tests.eq('paid claim: approved', (select approved_value from public.v_expense_claims where id = :'office_claim'), 45000::numeric);
select tests.eq('paid claim: paid', (select paid_value from public.v_expense_claims where id = :'office_claim'), 45000::numeric);
select tests.eq('paid claim: nothing left to pay', (select to_pay from public.v_expense_claims where id = :'office_claim'), 'MMK 0.00');

-- A claim approved but not yet paid shows what finance owes.
select tests.login('00000000-0000-0000-0000-0000000000b1');
select public.open_expense_claim('{"purpose":"Tools"}')->>'id' as tools_claim \gset
select public.save_advance_draft(:'tools_claim', jsonb_build_object('description', 'Spanner set', 'amount', 80000, 'date', current_date, 'receipt_file', 'sp.pdf'));
select public.save_advance_draft(:'tools_claim', jsonb_build_object('description', 'Gloves', 'amount', 5000, 'date', current_date, 'receipt_file', 'gl.pdf'));
select tests.eq('draft claim: claimed includes drafts', (select claimed_value from public.v_expense_claims where id = :'tools_claim'), 85000::numeric);
select tests.eq('draft claim: nothing approved yet', (select approved_value from public.v_expense_claims where id = :'tools_claim'), 0::numeric);
select public.submit_advance_settlement(:'tools_claim', null);
select tests.login('00000000-0000-0000-0000-0000000000a1');
select public.decide_advance_settlement(:'tools_claim', 'approve', null);
select tests.eq('approved claim: to pay = approved total', (select to_pay from public.v_expense_claims where id = :'tools_claim'), 'MMK 85,000.00');

-- Advances list: over-spent advance shows what the company owes, not a balance.
insert into public.advances (id, staff_id, job_id, purpose, amount, date)
values ('00000000-0000-0000-0000-0000000000e9', (select id from public.staff where profile_id = '00000000-0000-0000-0000-0000000000b1' limit 1),
        '00000000-0000-0000-0000-0000000000d1', 'Cable run', 10000, current_date);
select public.set_advance_status('00000000-0000-0000-0000-0000000000e9', 'Approved');
select tests.eq('approved (not released) advance: nothing spent or owed',
  (select issued_on is null and spent_value = 0 and balance_value = 0 from public.v_advances where id = '00000000-0000-0000-0000-0000000000e9'), true);
select public.issue_advance('00000000-0000-0000-0000-0000000000e9', '{"amount":10000,"method":"Cash"}');
select tests.eq('released advance: balance = amount', (select balance_value from public.v_advances where id = '00000000-0000-0000-0000-0000000000e9'), 10000::numeric);
select tests.login('00000000-0000-0000-0000-0000000000b1');
select public.save_advance_draft('00000000-0000-0000-0000-0000000000e9', jsonb_build_object('description', 'Cable', 'amount', 15000, 'date', current_date, 'receipt_file', 'c.pdf'));
select tests.eq('drafts do not count as spent yet', (select spent_value from public.v_advances where id = '00000000-0000-0000-0000-0000000000e9'), 0::numeric);
select public.submit_advance_settlement('00000000-0000-0000-0000-0000000000e9', null);
select tests.eq('over-spent advance: nothing to return, 5,000 to reimburse',
  (select balance_value || ' / ' || to_reimburse_value from public.v_advances where id = '00000000-0000-0000-0000-0000000000e9'), '0 / 5000.00');
select tests.login('00000000-0000-0000-0000-0000000000a1');
select tests.ok('unreleased advances show nothing spent or owed',
  not exists (select 1 from public.v_advances where lower(status) in ('pending approval', 'approved', 'rejected')
              and (spent_value <> 0 or balance_value <> 0 or to_reimburse_value <> 0)));
select tests.ok('closed advances show no balance either way',
  not exists (select 1 from public.v_advances where lower(status) = 'settled' and (balance_value <> 0 or to_reimburse_value <> 0)));

-- "Mine" filter: a finance user reads every advance but only theirs are marked mine.
select tests.login('00000000-0000-0000-0000-0000000000f1');
set role authenticated;
select tests.ok('finance sees other staff advances in the company list',
  exists (select 1 from public.v_advances where not is_mine));
select tests.ok('is_mine marks only the finance user''s own advances',
  not exists (select 1 from public.v_advances v join public.staff s on s.id = v.staff_id
              where v.is_mine and s.profile_id <> '00000000-0000-0000-0000-0000000000f1'));
reset role;

-- Cash board: opening a claim is not cash out.
select tests.ok('claims are not listed as staff advances in the cash movements',
  not exists (select 1 from public.cash_movements(null, null) m join public.advances a on a.number = m.reference where a.kind = 'Claim'));

-- Expenses & cash: company book only, no staff advances or advance/claim lines.
select tests.login('00000000-0000-0000-0000-0000000000a1');
set role authenticated;
select tests.ok('expense book does not repeat staff advances or claims',
  not exists (select 1 from public.v_expenses v join public.advances a on a.id = v.id));
select tests.ok('expense book does not list lines recorded inside an advance or claim',
  not exists (select 1 from public.v_expenses where advance_id is not null));
reset role;

-- Dashboard: a claim waiting for the manager counts once, not once per line.
select tests.login('00000000-0000-0000-0000-0000000000b1');
select (public.open_expense_claim('{"purpose":"Two taxis"}'::jsonb)->>'id') as count_claim \gset
select public.save_advance_draft(:'count_claim', jsonb_build_object('description', 'Taxi 1', 'amount', 3000, 'date', current_date, 'receipt_file', 't1.pdf'));
select public.save_advance_draft(:'count_claim', jsonb_build_object('description', 'Taxi 2', 'amount', 4000, 'date', current_date, 'receipt_file', 't2.pdf'));
select public.submit_advance_settlement(:'count_claim', null);
select tests.login('00000000-0000-0000-0000-0000000000a1');
select tests.eq('dashboard expense claims = stand-alone claims + staff claims under review',
  (public.dashboard_summary()->'counts'->>'pendingExpenseClaims')::int,
  ((select count(*) from public.expenses where deleted_at is null and advance_id is null and lower(status) = 'submitted')
   + (select count(*) from public.advances where deleted_at is null and kind = 'Claim' and lower(status) = 'under review'))::int);
select tests.eq('pending approvals count each settlement under review once',
  (public.dashboard_summary()->'counts'->>'pendingApprovals')::int,
  ((select count(*) from public.expenses where deleted_at is null and advance_id is null and lower(status) = 'submitted')
   + (select count(*) from public.material_requests where deleted_at is null and lower(status) in ('pending','pending approval'))
   + (select count(*) from public.advances where deleted_at is null and lower(status) in ('pending approval','approved'))
   + (select count(*) from public.advances where deleted_at is null and lower(status) = 'under review'))::int);
