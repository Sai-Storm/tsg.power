-- ============================================================================
-- Salary is admin-only
-- ============================================================================
-- Staff must not see any salary information:
--   1. Staff can no longer read rows from public.salaries (the "My salary"
--      screen has been removed from the staff panel).
--   2. The staff.salary column is no longer readable through the API. Every
--      signed-in user can still read the other staff columns (names are needed
--      for job assignment, lookups and joined views).
--   3. v_staff returns salary only to administrators. It runs with the view
--      owner's privileges so Admin's Staff management screen keeps working.
--
-- Idempotent: safe to run more than once.

-- 1. Salaries table: admin only --------------------------------------------
drop policy if exists salaries_staff_read on public.salaries;

-- 2. staff.salary column: not selectable by API roles ----------------------
revoke select on public.staff from anon, authenticated;
grant select (
  id, employee_id, name, phone, email, designation, join_date, status,
  profile_id, created_at, updated_at, deleted_at, deleted_by
) on public.staff to authenticated;

-- 3. v_staff: salary visible to admins only --------------------------------
drop view if exists public.v_staff;
create view public.v_staff
with (security_invoker = false) as
select
  s.id,
  s.employee_id,
  s.name,
  s.phone,
  s.email,
  s.designation,
  s.join_date,
  case when public.is_admin() then s.salary end as salary,
  s.status,
  s.profile_id,
  s.created_at,
  s.updated_at,
  s.deleted_at,
  s.deleted_by,
  s.name as staff_member,
  (
    select count(*) from public.jobs j
    where j.deleted_at is null
      and (j.assigned_to = s.id or j.team_leader = s.id or coalesce(j.assigned_employees, '[]'::jsonb) ? (s.id::text))
      and lower(j.status) not in ('completed', 'cancelled', 'closed - paid', 'closed - pending payment')
  ) as active_jobs
from public.staff s
where s.deleted_at is null
  and (public.is_admin() or public.is_staff());

revoke all on public.v_staff from anon;
grant select on public.v_staff to authenticated;
