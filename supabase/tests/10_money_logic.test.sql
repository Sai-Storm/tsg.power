-- ============================================================================
-- Money logic and access-rule tests
-- ============================================================================
-- Run with:  npm run test:db   (see scripts/test-db.mjs)
-- Every check writes a row to tests.results; the runner fails if any row has
-- ok = false or if any statement raises an unexpected error.
--
-- Fixed dates are used so the cash numbers never depend on "today".

\set ON_ERROR_STOP 0
\pset pager off

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create schema if not exists tests;
create table if not exists tests.results (id serial primary key, label text not null, ok boolean not null, detail text);
grant usage on schema tests to authenticated;
grant insert, select on tests.results to authenticated;
grant usage on sequence tests.results_id_seq to authenticated;

create or replace function tests.eq(p_label text, p_got anycompatible, p_want anycompatible)
returns void language plpgsql as $$
begin
  insert into tests.results (label, ok, detail)
  values (p_label, p_got is not distinct from p_want, format('got %s, expected %s', coalesce(p_got::text, 'NULL'), coalesce(p_want::text, 'NULL')));
end $$;

create or replace function tests.ok(p_label text, p_cond boolean, p_detail text default null)
returns void language plpgsql as $$
begin
  insert into tests.results (label, ok, detail) values (p_label, coalesce(p_cond, false), p_detail);
end $$;

-- Runs p_sql and passes only if it raises an error whose message matches p_pattern.
create or replace function tests.throws(p_label text, p_sql text, p_pattern text)
returns void language plpgsql as $$
begin
  execute p_sql;
  insert into tests.results (label, ok, detail) values (p_label, false, 'no error was raised');
exception when others then
  insert into tests.results (label, ok, detail)
  values (p_label, sqlerrm ~* p_pattern, 'error: ' || sqlerrm);
end $$;

grant execute on all functions in schema tests to authenticated;

-- Act as a signed-in user (API role + auth.uid()), or as the database owner.
create or replace function tests.login(p_user uuid)
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', p_user::text, false);
end $$;

-- ---------------------------------------------------------------------------
-- Fixtures: one admin, two staff, one customer, one job
-- ---------------------------------------------------------------------------
insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-0000-0000-0000000000a1', 'admin@test.local', '{"name":"Test Admin","role":"Admin","username":"tadmin"}'),
  ('00000000-0000-0000-0000-0000000000b1', 'staff1@test.local', '{"name":"Staff One","role":"Staff","username":"staff1"}'),
  ('00000000-0000-0000-0000-0000000000b2', 'staff2@test.local', '{"name":"Staff Two","role":"Staff","username":"staff2"}')
on conflict do nothing;

insert into public.profiles (id, email, username, name, role) values
  ('00000000-0000-0000-0000-0000000000a1', 'admin@test.local', 'tadmin', 'Test Admin', 'Admin'),
  ('00000000-0000-0000-0000-0000000000b1', 'staff1@test.local', 'staff1', 'Staff One', 'Staff'),
  ('00000000-0000-0000-0000-0000000000b2', 'staff2@test.local', 'staff2', 'Staff Two', 'Staff')
on conflict (id) do update set role = excluded.role, is_active = true;

-- The sign-up trigger may already have created staff rows; make sure both exist.
insert into public.staff (name, profile_id, designation)
select v.name, v.pid::uuid, 'Technician'
from (values ('Staff One', '00000000-0000-0000-0000-0000000000b1'), ('Staff Two', '00000000-0000-0000-0000-0000000000b2')) v(name, pid)
where not exists (select 1 from public.staff s where s.profile_id = v.pid::uuid);

create temp table ids as
select
  (select id from public.staff where profile_id = '00000000-0000-0000-0000-0000000000b1' limit 1) as s1,
  (select id from public.staff where profile_id = '00000000-0000-0000-0000-0000000000b2' limit 1) as s2;
grant select on ids to authenticated;

insert into public.customers (id, name) values ('00000000-0000-0000-0000-0000000000c1', 'Test Customer') on conflict do nothing;
insert into public.jobs (id, title, customer_id) values ('00000000-0000-0000-0000-0000000000d1', 'Generator maintenance', '00000000-0000-0000-0000-0000000000c1') on conflict do nothing;

insert into public.settings (key, label, value) values ('opening_cash_balance', 'Opening cash balance', '2000000')
on conflict (key) do update set value = excluded.value;

-- ---------------------------------------------------------------------------
-- 1. Advance requests must name a job order
-- ---------------------------------------------------------------------------
select tests.throws('advance without job order is refused',
  format($q$insert into public.advances (staff_id, amount) values (%L, 1000)$q$, (select s1 from ids)),
  'job order');

insert into public.advances (id, staff_id, job_id, amount, purpose, date, due_date) values
  ('00000000-0000-0000-0000-0000000000e1', (select s1 from ids), '00000000-0000-0000-0000-0000000000d1', 1000000, 'Generator service', '2026-11-05', '2026-11-30'),
  ('00000000-0000-0000-0000-0000000000e2', (select s1 from ids), '00000000-0000-0000-0000-0000000000d1', 100000, 'Small job', '2026-11-05', '2026-11-30'),
  ('00000000-0000-0000-0000-0000000000e3', (select s1 from ids), '00000000-0000-0000-0000-0000000000d1', 50000, 'Overdue one', '2026-10-01', '2026-10-15');

-- ---------------------------------------------------------------------------
-- 2. Manager approves, finance releases
-- ---------------------------------------------------------------------------
select tests.login('00000000-0000-0000-0000-0000000000b1');
select tests.throws('staff cannot approve an advance',
  $q$select public.set_advance_status('00000000-0000-0000-0000-0000000000e1', 'Approved')$q$, 'administrator');

select tests.login('00000000-0000-0000-0000-0000000000a1');
select tests.throws('cannot release money before approval',
  $q$select public.issue_advance('00000000-0000-0000-0000-0000000000e1', '{"amount":1000000}')$q$, 'approved advance');
select tests.eq('approve request', public.set_advance_status('00000000-0000-0000-0000-0000000000e1', 'Approved')->>'status', 'Approved');
select tests.eq('release money', public.issue_advance('00000000-0000-0000-0000-0000000000e1', '{"amount":1000000,"date":"2026-11-10","method":"Cash","reference":"PV-1"}')->>'status', 'Issued');
select public.set_advance_status('00000000-0000-0000-0000-0000000000e2', 'Approved');
select public.issue_advance('00000000-0000-0000-0000-0000000000e2', '{"amount":100000,"date":"2026-11-10","method":"Cash"}');
select public.set_advance_status('00000000-0000-0000-0000-0000000000e3', 'Approved');
select public.issue_advance('00000000-0000-0000-0000-0000000000e3', '{"amount":50000,"date":"2026-10-02","method":"Cash"}');
select tests.throws('cannot release the same advance twice',
  $q$select public.issue_advance('00000000-0000-0000-0000-0000000000e1', '{"amount":1000000}')$q$, 'approved advance');

-- ---------------------------------------------------------------------------
-- 3. Staff record drafts (nothing is sent)
-- ---------------------------------------------------------------------------
select tests.login('00000000-0000-0000-0000-0000000000b2');
select tests.throws('another staff member cannot add expenses to my advance',
  $q$select public.save_advance_draft('00000000-0000-0000-0000-0000000000e1', '{"description":"x","amount":1}')$q$, 'not authorized');

select tests.login('00000000-0000-0000-0000-0000000000b1');
select (select count(*) from public.notifications) as notes_before \gset
select public.save_advance_draft('00000000-0000-0000-0000-0000000000e1', '{"category":"SKU / Materials","description":"SKU purchase","amount":300000,"date":"2026-11-11","receipt_file":"r1.pdf","notes":"For TSG job"}');
select public.save_advance_draft('00000000-0000-0000-0000-0000000000e1', '{"category":"Transportation","description":"Transportation","amount":100000,"date":"2026-11-12","receipt_file":"r2.pdf"}');
select public.save_advance_draft('00000000-0000-0000-0000-0000000000e1', '{"category":"Spare parts","description":"Generator parts","amount":400000,"date":"2026-11-12"}');
select tests.eq('saving drafts sends no notifications', (select count(*) from public.notifications), :notes_before::bigint);
select tests.eq('draft expenses inherit the job order',
  (select count(*) from public.expenses where advance_id = '00000000-0000-0000-0000-0000000000e1' and job_id = '00000000-0000-0000-0000-0000000000d1'), 3::bigint);
select tests.eq('drafts do not change the claimed amount',
  (select claimed from public.advances where id = '00000000-0000-0000-0000-0000000000e1'), 0::numeric);
select tests.eq('summary shows draft total',
  (public.advance_expenses('00000000-0000-0000-0000-0000000000e1')->'advance'->>'drafts')::numeric, 800000::numeric);
select tests.throws('cannot submit while a receipt is missing',
  $q$select public.submit_advance_settlement('00000000-0000-0000-0000-0000000000e1', null)$q$, 'no receipt');

update public.expenses set receipt_file = 'r3.pdf' where description = 'Generator parts';

-- ---------------------------------------------------------------------------
-- 4. Submit settlement (once only)
-- ---------------------------------------------------------------------------
select tests.eq('submit settlement',
  public.submit_advance_settlement('00000000-0000-0000-0000-0000000000e1', 'done')->'advance'->>'status', 'Under Review');
select tests.eq('claimed = submitted expenses',
  (select claimed from public.advances where id = '00000000-0000-0000-0000-0000000000e1'), 800000::numeric);
select tests.throws('cannot submit the same settlement twice',
  $q$select public.submit_advance_settlement('00000000-0000-0000-0000-0000000000e1', null)$q$, 'cannot be submitted again');
select tests.eq('each expense is in exactly one submission',
  (select count(*) from public.advance_submission_items i join public.expenses e on e.id = i.expense_id where e.advance_id = '00000000-0000-0000-0000-0000000000e1'), 3::bigint);
select tests.throws('staff cannot review their own expenses',
  format($q$select public.review_advance_expense(%L, 'Approved', null)$q$, (select id from public.expenses where description = 'SKU purchase')), 'administrator');

-- ---------------------------------------------------------------------------
-- 5. Manager review
-- ---------------------------------------------------------------------------
select tests.login('00000000-0000-0000-0000-0000000000a1');
select tests.throws('rejecting needs a reason',
  format($q$select public.review_advance_expense(%L, 'Rejected', '')$q$, (select id from public.expenses where description = 'Transportation')), 'reason');
select tests.eq('rejecting an expense lowers claimed',
  (public.review_advance_expense((select id from public.expenses where description = 'Transportation'), 'Rejected', 'No ticket')->'advance'->>'claimed')::numeric, 700000::numeric);
select tests.throws('advance expenses cannot be approved from the claims list',
  format($q$select public.set_expense_status(%L, 'Approved')$q$, (select id from public.expenses where description = 'SKU purchase')), 'staff advance');
select tests.eq('approve settlement',
  public.decide_advance_settlement('00000000-0000-0000-0000-0000000000e1', 'approve', 'ok')->'advance'->>'status', 'Settlement Approved');
select tests.eq('approved total excludes the rejected expense',
  (public.advance_expenses('00000000-0000-0000-0000-0000000000e1')->'advance'->>'approved')::numeric, 700000::numeric);

-- ---------------------------------------------------------------------------
-- 6. Finance reconciles: under-spent -> staff returns the rest
-- ---------------------------------------------------------------------------
select tests.eq('reconcile closes the advance',
  public.reconcile_advance('00000000-0000-0000-0000-0000000000e1', '{"date":"2026-11-20","method":"Cash","reference":"RC-1"}')->'advance'->>'status', 'Settled');
select tests.eq('returned cash = advance - approved expenses',
  (select sum(amount) from public.advance_returns where advance_id = '00000000-0000-0000-0000-0000000000e1'), 300000::numeric);
select tests.eq('return posted to cash book against the job order',
  (select count(*) from public.cash_entries where reference_type = 'Advance return' and amount = 300000 and job_id = '00000000-0000-0000-0000-0000000000d1' and lower(status) = 'posted' and date = '2026-11-20'), 1::bigint);
select tests.throws('cannot reconcile a closed advance twice',
  $q$select public.reconcile_advance('00000000-0000-0000-0000-0000000000e1', '{}')$q$, 'must be approved');
select tests.eq('closed advance shows zero balance',
  (select balance from public.v_advances where id = '00000000-0000-0000-0000-0000000000e1'), 'MMK 0.00');

-- ---------------------------------------------------------------------------
-- 7. Over-spent -> returned to staff once, then reimbursed
-- ---------------------------------------------------------------------------
select tests.login('00000000-0000-0000-0000-0000000000b1');
select public.save_advance_draft('00000000-0000-0000-0000-0000000000e2', '{"description":"Fuel","amount":150000,"date":"2026-11-13","receipt_file":"r9.pdf"}');
select public.submit_advance_settlement('00000000-0000-0000-0000-0000000000e2', null);
select tests.login('00000000-0000-0000-0000-0000000000a1');
select tests.throws('returning to staff needs a note',
  $q$select public.decide_advance_settlement('00000000-0000-0000-0000-0000000000e2', 'return', '')$q$, 'what to change');
select tests.eq('return to staff reopens the advance',
  public.decide_advance_settlement('00000000-0000-0000-0000-0000000000e2', 'return', 'Attach fuel log')->'advance'->>'status', 'Issued');
select tests.eq('returned expenses go back to draft', (select status from public.expenses where description = 'Fuel'), 'Draft');
select tests.login('00000000-0000-0000-0000-0000000000b1');
select tests.eq('staff can resubmit after a return',
  public.submit_advance_settlement('00000000-0000-0000-0000-0000000000e2', null)->'advance'->>'status', 'Under Review');
select tests.login('00000000-0000-0000-0000-0000000000a1');
select public.decide_advance_settlement('00000000-0000-0000-0000-0000000000e2', 'approve', null);
select tests.eq('over-spend is reimbursed to staff',
  (public.reconcile_advance('00000000-0000-0000-0000-0000000000e2', '{"date":"2026-11-21","method":"Cash"}')->'advance'->>'reimbursed_amount')::numeric, 50000::numeric);
select tests.eq('reimbursement posted as a cash payment',
  (select sum(amount) from public.cash_entries where reference_type = 'Advance reimbursement' and lower(type) = 'payment'), 50000::numeric);

-- ---------------------------------------------------------------------------
-- 8. Cash board totals
-- ---------------------------------------------------------------------------
-- November: invoice payment 200,000 in; advance return 300,000 in;
-- advances released 1,000,000 + 100,000 out; reimbursement 50,000 out;
-- salary paid 300,000 out. Advance-funded expenses are NOT cash out (the
-- advance itself already was). October: overdue advance 50,000 out.
insert into public.invoices (id, number, customer_id, job_id, date, due_date, total, status)
values ('00000000-0000-0000-0000-0000000000f1', 'INV-T-1', '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000d1', '2026-11-14', '2026-12-14', 500000, 'Issued');
select public.record_invoice_payment('00000000-0000-0000-0000-0000000000f1', '{"amount":200000,"date":"2026-11-15","method":"Cash"}');
select tests.throws('cannot receive more than the invoice balance',
  $q$select public.record_invoice_payment('00000000-0000-0000-0000-0000000000f1', '{"amount":400000}')$q$, 'more than the outstanding');

insert into public.salaries (id, staff_id, salary_month, basic_salary, status)
values ('00000000-0000-0000-0000-0000000000f2', (select s1 from ids), '2026-11', 300000, 'Draft');
update public.salaries set status = 'Paid', paid_on = '2026-11-25' where id = '00000000-0000-0000-0000-0000000000f2';

select tests.eq('November cash in', (public.cash_board('2026-11-01', '2026-11-30')->>'income')::numeric, 500000::numeric);
select tests.eq('November cash out', (public.cash_board('2026-11-01', '2026-11-30')->>'expense')::numeric, 1450000::numeric);
select tests.eq('November opening = opening balance - October movements',
  (public.cash_board('2026-11-01', '2026-11-30')->>'opening')::numeric, 1950000::numeric);
select tests.eq('December opening carries November forward',
  (public.cash_board('2026-12-01', '2026-12-31')->>'opening')::numeric, 1000000::numeric);
select tests.eq('advance-funded expenses never appear as cash out',
  (select count(*) from public.cash_movements(null, null) m where m.source = 'Expense' and m.reference in (select number from public.expenses where advance_id is not null)), 0::bigint);

-- ---------------------------------------------------------------------------
-- 9. Access rules (run as the API role, so row level security applies)
-- ---------------------------------------------------------------------------
select tests.login('00000000-0000-0000-0000-0000000000b2');
set role authenticated;
select tests.eq('staff cannot see another staff member''s advances',
  (select count(*) from public.advances where staff_id = (select s1 from ids)), 0::bigint);
select tests.eq('staff cannot see another staff member''s expenses',
  (select count(*) from public.expenses where employee_id = (select s1 from ids)), 0::bigint);
select tests.eq('staff cannot see any salaries', (select count(*) from public.salaries), 0::bigint);
select tests.eq('staff cannot see the cash book', (select count(*) from public.cash_entries), 0::bigint);
select tests.eq('staff cannot see others'' advance returns', (select count(*) from public.advance_returns), 0::bigint);
select tests.eq('staff cannot see others'' advance history', (select count(*) from public.advance_approvals), 0::bigint);
select tests.eq('staff cannot see others'' notifications',
  (select count(*) from public.notifications where user_id <> '00000000-0000-0000-0000-0000000000b2'), 0::bigint);
select tests.throws('staff cannot open the cash board', $q$select public.cash_board('2026-11-01', '2026-11-30')$q$, 'administrator');
select tests.throws('staff cannot read another staff member''s advance window',
  $q$select public.advance_expenses('00000000-0000-0000-0000-0000000000e1')$q$, 'not authorized');
-- A staff request is always forced back to a plain pending request.
with req as (
  insert into public.advances (staff_id, job_id, amount, status, claimed, issued_on, returned_amount)
  values ((select s1 from ids), '00000000-0000-0000-0000-0000000000d1', 5000, 'Issued', 5000, '2026-11-01', 9999)
  returning status, claimed, issued_on, returned_amount, staff_id
)
select tests.ok('staff request cannot arrive released, claimed or for someone else',
  (select status = 'Pending Approval' and claimed = 0 and issued_on is null and returned_amount = 0 and staff_id = (select s2 from ids) from req),
  (select format('status=%s claimed=%s issued_on=%s', status, claimed, issued_on) from req));
reset role;

select tests.login('00000000-0000-0000-0000-0000000000b1');
set role authenticated;
select tests.eq('staff see their own advances', (select count(*) from public.advances), 3::bigint);
select tests.eq('staff see their own advance returns', (select count(*) from public.advance_returns), 1::bigint);
reset role;

select tests.eq('every table in the public schema has row level security on',
  (select string_agg(c.relname, ', ' order by c.relname) from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity), null::text);
