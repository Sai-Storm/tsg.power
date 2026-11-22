-- ============================================================================
-- Split expense claims from advances (separate lists, separate maths)
-- ============================================================================
-- Claims keep the same settlement engine (advances.kind = 'Claim'), but are
-- listed on their own so every column means one thing:
--
--   v_advances (kind 'Advance' only)
--     amount        money given to the staff member (requested amount until released)
--     spent         expenses sent for settlement (submitted + approved, not drafts/rejected)
--     balance       to return: amount - spent, while the advance is out
--     to_reimburse  company owes staff: spent - amount, while the advance is out
--     Before release and after closing both balance columns are 0.
--
--   v_expense_claims (kind 'Claim' only)
--     claimed       everything recorded and not rejected (drafts included)
--     approved      approved by the manager
--     paid          reimbursed by finance
--     to_pay        approved - paid, once the claim is approved
--
-- Both views have is_mine so "My advances" / "My expense claims" show only the
-- signed-in person's rows, also for Finance users who can read everyone's.

-- 1. Advances list --------------------------------------------------------------
drop view if exists public.v_advances;
create view public.v_advances
with (security_invoker = true) as
with figures as (
  select a.*,
    lower(a.status) in ('issued', 'open', 'partially settled', 'under review', 'settlement approved') as is_out,
    lower(a.status) in ('pending approval', 'approved', 'rejected') as not_released
  from public.advances a
  where a.deleted_at is null and a.kind = 'Advance'
)
select f.id,
  f.number as advance,
  coalesce(f.issued_on, f.date) as issued,
  f.date as requested,
  f.purpose,
  public.money(f.amount) as amount,
  public.money(case when f.not_released then 0 else f.claimed end) as spent,
  public.money(case when f.is_out then greatest(f.amount - f.claimed, 0) else 0 end) as balance,
  public.money(case when f.is_out then greatest(f.claimed - f.amount, 0) else 0 end) as to_reimburse,
  public.money(f.returned_amount) as returned,
  public.money(f.reimbursed_amount) as reimbursed,
  f.status,
  f.amount as amount_value,
  case when f.not_released then 0 else f.claimed end as spent_value,
  case when f.is_out then greatest(f.amount - f.claimed, 0) else 0 end as balance_value,
  case when f.is_out then greatest(f.claimed - f.amount, 0) else 0 end as to_reimburse_value,
  f.staff_id,
  f.job_id,
  f.due_date,
  f.issued_on,
  f.settled_at,
  f.created_by,
  f.created_at,
  f.updated_at,
  st.name as staff_name,
  j.number as job_order,
  f.staff_id = public.current_staff_id() as is_mine
from figures f
left join public.staff st on st.id = f.staff_id
left join public.jobs j on j.id = f.job_id;

grant select on public.v_advances to authenticated;

-- 2. Expense claims list ----------------------------------------------------------
create or replace view public.v_expense_claims
with (security_invoker = true) as
select a.id,
  a.number as claim,
  a.date,
  a.purpose,
  coalesce(j.number, 'Office') as job_order,
  st.name as staff_name,
  coalesce(x.items, 0) as items,
  public.money(coalesce(x.claimed, 0)) as claimed,
  public.money(coalesce(x.approved, 0)) as approved,
  public.money(a.reimbursed_amount) as paid,
  public.money(case when lower(a.status) = 'settlement approved' then greatest(coalesce(x.approved, 0) - a.reimbursed_amount, 0) else 0 end) as to_pay,
  a.status,
  coalesce(x.claimed, 0) as claimed_value,
  coalesce(x.approved, 0) as approved_value,
  a.reimbursed_amount as paid_value,
  coalesce(x.drafts, 0) as draft_value,
  a.staff_id,
  a.job_id,
  a.submitted_at,
  a.settled_at,
  a.created_by,
  a.created_at,
  a.updated_at,
  a.staff_id = public.current_staff_id() as is_mine
from public.advances a
left join public.staff st on st.id = a.staff_id
left join public.jobs j on j.id = a.job_id
left join lateral (
  select count(*) as items,
         sum(e.amount) filter (where lower(e.status) <> 'rejected') as claimed,
         sum(e.amount) filter (where lower(e.status) in ('approved', 'paid')) as approved,
         sum(e.amount) filter (where lower(e.status) = 'draft') as drafts
  from public.expenses e
  where e.advance_id = a.id and e.deleted_at is null
) x on true
where a.deleted_at is null and a.kind = 'Claim';

grant select on public.v_expense_claims to authenticated;

-- 3. Claims are not cash handed out, and not advances in the overview -------------
do $$
declare
  v_def text;
  v_new text;
begin
  -- Cash board: a claim never put money in the staff member's hand (its
  -- payment is the cash entry posted when finance pays it).
  v_def := pg_get_functiondef('public.cash_movements(date, date)'::regprocedure);
  v_new := replace(v_def, 'where a.deleted_at is null and a.issued_on is not null',
                          $r$where a.deleted_at is null and a.issued_on is not null and a.kind = 'Advance'$r$);
  if v_new = v_def then raise exception 'cash_movements patch did not apply'; end if;
  execute v_new;

  -- Advance overview stage counts: advances only (claims have their own list;
  -- they still appear under "waiting for review").
  v_def := pg_get_functiondef('public.advance_overview()'::regprocedure);
  v_new := replace(v_def, 'left join public.advances a on a.deleted_at is null',
                          $r$left join public.advances a on a.deleted_at is null and a.kind = 'Advance'$r$);
  if v_new = v_def then raise exception 'advance_overview patch did not apply'; end if;
  execute v_new;
end $$;

-- 4. Version ------------------------------------------------------------------------
create or replace function public.schema_version()
returns text language sql immutable as $$ select '20261128000000'::text $$;
grant execute on function public.schema_version() to anon, authenticated;
