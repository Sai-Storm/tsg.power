-- ============================================================================
-- "Expense & claims" becomes the company expense book
-- ============================================================================
-- Staff money now has one home each:
--   Staff advances  -> v_advances        (advances.kind = 'Advance')
--   Staff claims    -> v_expense_claims  (advances.kind = 'Claim')
--   Expenses & cash -> v_expenses        (company expense vouchers + cash entries)
--
-- So v_expenses no longer repeats staff advances, and no longer lists the
-- expense lines recorded inside an advance or claim (those are reviewed in the
-- advance/claim window). Older stand-alone staff expense claims stay here until
-- they are paid.
--
-- The dashboard counts follow: a claim waiting for the manager counts once
-- (not once per expense line), and advance settlements count as approvals.

-- 1. Expense book --------------------------------------------------------------
create or replace view public.v_expenses
with (security_invoker = true) as
select
  e.id,
  e.number as reference,
  e.number as voucher,
  case when e.payment_source = 'Employee' and e.employee_id is not null
       then 'Staff expense claim' else 'Expense' end::text as type,
  e.category,
  coalesce(st.name, e.supplier_name, 'Company') as employee_source,
  j.number as job_order,
  e.date,
  public.money(e.amount) as amount,
  e.status,
  e.id as expense_id,
  e.amount as amount_value,
  e.employee_id,
  e.job_id,
  e.office_type,
  e.supplier_id,
  e.supplier_name,
  e.currency,
  e.description,
  e.payment_source,
  e.advance_id,
  e.receipt_file,
  e.exception_reason,
  e.approved_by,
  e.approved_at,
  e.reimbursed_at,
  e.created_by,
  e.created_at,
  e.updated_at
from public.expenses e
left join public.staff st on st.id = e.employee_id
left join public.jobs j on j.id = e.job_id
where e.deleted_at is null
  and e.advance_id is null
union all
select
  ce.id,
  ce.number,
  ce.number,
  ('Cash ' || ce.type)::text,
  'Cash'::text,
  coalesce(ce.counterparty, ce.account, 'Company cash'),
  j.number,
  ce.date,
  public.money(ce.amount),
  ce.status,
  ce.id,
  ce.amount,
  null,
  ce.job_id,
  null,
  null,
  null,
  null,
  ce.description,
  null,
  null,
  ce.attachment,
  null,
  null,
  null,
  null,
  ce.created_by,
  ce.created_at,
  ce.updated_at
from public.cash_entries ce
left join public.jobs j on j.id = ce.job_id
where ce.deleted_at is null and public.is_finance();

grant select on public.v_expenses to authenticated;

-- 2. Dashboard counts ---------------------------------------------------------------
do $$
declare
  v_def text;
  v_new text;
  v_old_count constant text := $q$(select count(*) from public.expenses where deleted_at is null and lower(status) = 'submitted')$q$;
begin
  v_def := pg_get_functiondef('public.dashboard_summary()'::regprocedure);

  -- "Expense claims" on the dashboard: stand-alone claims + staff claims under review.
  v_new := replace(v_def, $q$'pendingExpenseClaims', $q$ || v_old_count,
    $q$'pendingExpenseClaims', ((select count(*) from public.expenses where deleted_at is null and advance_id is null and lower(status) = 'submitted')
        + (select count(*) from public.advances where deleted_at is null and kind = 'Claim' and lower(status) = 'under review'))$q$);
  if v_new = v_def then raise exception 'dashboard_summary pendingExpenseClaims patch did not apply'; end if;

  -- "Pending approvals": stand-alone claims + every advance/claim settlement under review
  -- (previously each submitted expense line inside an advance counted separately).
  v_def := v_new;
  v_new := replace(v_def, v_old_count,
    $q$((select count(*) from public.expenses where deleted_at is null and advance_id is null and lower(status) = 'submitted')
        + (select count(*) from public.advances where deleted_at is null and lower(status) = 'under review'))$q$);
  if v_new = v_def then raise exception 'dashboard_summary pendingApprovals patch did not apply'; end if;

  execute v_new;
end $$;

-- 3. Version ------------------------------------------------------------------------
create or replace function public.schema_version()
returns text language sql immutable as $$ select '20261129000000'::text $$;
grant execute on function public.schema_version() to anon, authenticated;
