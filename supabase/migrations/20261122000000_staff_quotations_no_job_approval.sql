-- ============================================================================
-- Quotations move to Staff; Admin no longer approves job orders
-- ============================================================================
-- Admin only manages finance. Operations (quotations, job orders) belong to
-- Staff:
--   * Staff create, edit, issue and convert quotations. Admin keeps read-only
--     access because invoices reference quotations.
--   * Quotations have no approval step: Draft -> Sent -> Accepted/Rejected ->
--     Converted to Job.
--   * Job orders have no approval step: a converted quotation creates a Draft
--     job that Staff assign/schedule themselves.
--   * Pending approvals on the admin dashboard no longer count quotations.
--
-- Idempotent: safe to run more than once.

-- Quotations: staff write, everyone signed-in reads -------------------------
drop policy if exists quotations_admin on public.quotations;
drop policy if exists quotations_staff on public.quotations;
create policy quotations_staff on public.quotations
  for all to authenticated
  using (public.is_staff())
  with check (public.is_staff());

-- Convert quotation -> job (staff) ------------------------------------------
create or replace function public.convert_quotation_to_job(p_quotation uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_quote public.quotations;
  v_job public.jobs;
begin
  if not public.is_staff() then
    raise exception 'Only staff can convert quotations' using errcode = '42501';
  end if;
  select * into v_quote from public.quotations where id = p_quotation and deleted_at is null;
  if v_quote.id is null then
    raise exception 'Quotation not found';
  end if;

  insert into public.jobs (
    job_date, job_type, priority, status, customer_id, quotation_id, customer_approval,
    payment_terms, title, description, scope_of_work, job_amount, created_by
  ) values (
    current_date, v_quote.job_type, 'Normal', 'Draft', v_quote.customer_id, v_quote.id, 'Accepted',
    v_quote.payment_terms, 'Service from ' || v_quote.number, v_quote.scope_of_work, v_quote.scope_of_work,
    v_quote.total, auth.uid()
  )
  returning * into v_job;

  update public.quotations set status = 'Converted to Job' where id = p_quotation;
  return to_jsonb(v_job);
end;
$$;

grant execute on function public.convert_quotation_to_job(uuid) to authenticated;

-- Assign / schedule job (staff who created or work on the job) -------------
create or replace function public.assign_job(p_job uuid, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.jobs;
  v_status text;
begin
  if not (
    public.is_admin()
    or public.is_job_member(p_job)
    or exists (select 1 from public.jobs j where j.id = p_job and j.created_by = auth.uid())
  ) then
    raise exception 'Not authorized to assign this job' using errcode = '42501';
  end if;

  v_status := case
    when nullif(p_payload->>'planned_start_date', '') is not null or nullif(p_payload->>'planned_end_date', '') is not null then 'Scheduled'
    else 'Assigned'
  end;

  update public.jobs set
    team_leader = coalesce(nullif(p_payload->>'team_leader', '')::uuid, team_leader),
    assigned_to = coalesce(nullif(p_payload->>'assigned_to', '')::uuid, assigned_to),
    assigned_employees = coalesce(p_payload->'assigned_employees', assigned_employees),
    planned_start_date = coalesce(nullif(p_payload->>'planned_start_date', '')::date, planned_start_date),
    planned_end_date = coalesce(nullif(p_payload->>'planned_end_date', '')::date, planned_end_date),
    assigned_vehicle = coalesce(nullif(p_payload->>'assigned_vehicle', '')::uuid, assigned_vehicle),
    responsibilities = coalesce(nullif(p_payload->>'responsibilities', ''), responsibilities),
    assignment_date = current_date,
    status = case when lower(status) in ('draft', 'new', 'pending approval', 'approved', 'assigned', 'scheduled') then v_status else status end
  where id = p_job and deleted_at is null
  returning * into v_row;

  if v_row.id is null then
    raise exception 'Job not found';
  end if;
  return to_jsonb(v_row);
end;
$$;

grant execute on function public.assign_job(uuid, jsonb) to authenticated;

-- Retire the approval statuses ---------------------------------------------
alter table public.jobs alter column status set default 'Draft';
alter table public.quotations alter column status set default 'Draft';

-- Existing jobs waiting for approval go back to Draft; the assignment trigger
-- moves those that already have a team to Assigned / Scheduled.
update public.jobs
set status = 'Draft'
where deleted_at is null and lower(status) in ('pending approval', 'approved');

update public.quotations
set status = 'Draft'
where deleted_at is null and lower(status) in ('pending approval', 'approved');

-- Dashboard: pending approvals no longer include quotations ----------------
create or replace function public.dashboard_summary()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_result jsonb;
  v_revenue jsonb;
  v_cash jsonb;
  v_jobs jsonb;
  v_opening numeric := 0;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  select coalesce(nullif(value, '')::numeric, 0) into v_opening
  from public.settings where key = 'opening_cash_balance';
  v_opening := coalesce(v_opening, 0);

  with months as (
    select generate_series(
      date_trunc('month', current_date) - interval '5 months',
      date_trunc('month', current_date),
      interval '1 month'
    ) as m
  )
  select jsonb_agg(jsonb_build_object(
    'month', to_char(m, 'Mon'),
    'revenue', coalesce((
      select sum(ip.amount) from public.invoice_payments ip
      where ip.date >= m::date and ip.date < (m + interval '1 month')::date
    ), 0),
    'expenses', coalesce((
      select sum(e.amount) from public.expenses e
      where e.deleted_at is null
        and lower(e.status) in ('approved', 'paid')
        and e.date >= m::date and e.date < (m + interval '1 month')::date
    ), 0)
  ) order by m)
  into v_revenue
  from months;

  with months as (
    select generate_series(
      date_trunc('month', current_date) - interval '5 months',
      date_trunc('month', current_date),
      interval '1 month'
    ) as m
  )
  select jsonb_agg(jsonb_build_object(
    'month', to_char(m, 'Mon'),
    'revenue', coalesce((
      select sum(ip.amount) from public.invoice_payments ip
      where ip.date >= m::date and ip.date < (m + interval '1 month')::date
    ), 0) + coalesce((
      select sum(ce.amount) from public.cash_entries ce
      where ce.deleted_at is null and lower(ce.status) = 'posted' and lower(ce.type) = 'receipt'
        and ce.date >= m::date and ce.date < (m + interval '1 month')::date
    ), 0),
    'expenses', coalesce((
      select sum(e.amount) from public.expenses e
      where e.deleted_at is null and lower(e.status) = 'paid'
        and e.date >= m::date and e.date < (m + interval '1 month')::date
    ), 0) + coalesce((
      select sum(ce.amount) from public.cash_entries ce
      where ce.deleted_at is null and lower(ce.status) = 'posted' and lower(ce.type) = 'payment'
        and ce.date >= m::date and ce.date < (m + interval '1 month')::date
    ), 0)
  ) order by m)
  into v_cash
  from months;

  select coalesce(jsonb_object_agg(status, total), '{}'::jsonb) into v_jobs
  from (
    select status, count(*)::int as total
    from public.jobs
    where deleted_at is null
    group by status
  ) q;

  select jsonb_build_object(
    'counts', jsonb_build_object(
      'activeJobs', (select count(*) from public.jobs where deleted_at is null and lower(status) not in ('completed','cancelled','closed - paid','closed - pending payment')),
      'pendingQuotations', (select count(*) from public.quotations where deleted_at is null and lower(status) in ('draft','pending approval')),
      'outstandingPayments', (select coalesce(sum(greatest(total - amount_received, 0)), 0) from public.invoices where deleted_at is null and lower(status) not in ('paid','cancelled','void')),
      'totalRevenue', (select coalesce(sum(amount), 0) from public.invoice_payments),
      'totalExpenses', (select coalesce(sum(amount), 0) from public.expenses where deleted_at is null and lower(status) in ('approved','paid')),
      'netCashBalance', v_opening
        + (select coalesce(sum(amount), 0) from public.invoice_payments)
        + (select coalesce(sum(amount), 0) from public.cash_entries where deleted_at is null and lower(status) = 'posted' and lower(type) = 'receipt')
        - (select coalesce(sum(amount), 0) from public.expenses where deleted_at is null and lower(status) = 'paid')
        - (select coalesce(sum(amount), 0) from public.cash_entries where deleted_at is null and lower(status) = 'posted' and lower(type) = 'payment'),
      'pendingApprovals',
        (select count(*) from public.expenses where deleted_at is null and lower(status) = 'submitted')
        + (select count(*) from public.material_requests where deleted_at is null and lower(status) in ('pending','pending approval'))
        + (select count(*) from public.advances where deleted_at is null and lower(status) in ('pending approval','approved')),
      'pendingExpenseClaims', (select count(*) from public.expenses where deleted_at is null and lower(status) = 'submitted'),
      'pendingMaterialRequests', (select count(*) from public.material_requests where deleted_at is null and lower(status) in ('pending','pending approval')),
      'pendingAdvances', (select count(*) from public.advances where deleted_at is null and lower(status) in ('pending approval','approved')),
      'customers', (select count(*) from public.customers where deleted_at is null and lower(status) = 'active'),
      'unpaidInvoices', (select count(*) from public.invoices where deleted_at is null and lower(status) in ('unpaid','partially paid','issued')),
      'myAssignedJobs', (
        select count(*) from public.jobs j
        where j.deleted_at is null
          and lower(j.status) not in ('completed','cancelled','closed - paid','closed - pending payment')
          and (
            j.assigned_to in (select public.my_staff_ids())
            or j.team_leader in (select public.my_staff_ids())
            or exists (
              select 1 from jsonb_array_elements_text(coalesce(j.assigned_employees, '[]'::jsonb)) entry
              where entry in (select t.id::text from public.my_staff_ids() t(id))
            )
          )
      ),
      'todaysScheduledJobs', (
        select count(*) from public.jobs j
        where j.deleted_at is null
          and lower(j.status) not in ('completed','cancelled','closed - paid','closed - pending payment')
          and coalesce(j.planned_start_date, j.job_date) = current_date
          and (
            j.assigned_to in (select public.my_staff_ids())
            or j.team_leader in (select public.my_staff_ids())
            or exists (
              select 1 from jsonb_array_elements_text(coalesce(j.assigned_employees, '[]'::jsonb)) entry
              where entry in (select t.id::text from public.my_staff_ids() t(id))
            )
          )
      ),
      'myPendingClaims', (
        select coalesce(sum(e.amount), 0) from public.expenses e
        where e.deleted_at is null
          and e.employee_id in (select public.my_staff_ids())
          and lower(e.status) in ('submitted','pending approval')
      ),
      'myOpenAdvanceBalance', (
        select coalesce(sum(a.balance), 0) from public.advances a
        where a.deleted_at is null
          and a.staff_id in (select public.my_staff_ids())
          and lower(a.status) in ('issued','partially settled')
      )
    ),
    'jobsByStatus', v_jobs,
    'monthlyRevenueExpenses', coalesce(v_revenue, '[]'::jsonb),
    'monthlyCashFlow', coalesce(v_cash, '[]'::jsonb),
    'comparisons', '{}'::jsonb
  ) into v_result;

  return v_result;
end;
$$;

grant execute on function public.dashboard_summary() to authenticated;
