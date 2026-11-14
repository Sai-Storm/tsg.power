-- Clear the old sample opening balance and expose live Staff dashboard metrics.
update public.settings
set value = '0', updated_at = now()
where key = 'opening_cash_balance' and value = '240000';

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
  v_staff uuid;
begin
  if auth.uid() is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  v_staff := public.current_staff_id();

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
        (select count(*) from public.quotations where deleted_at is null and lower(status) in ('draft','pending approval'))
        + (select count(*) from public.expenses where deleted_at is null and lower(status) = 'submitted')
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
          and v_staff is not null
          and lower(j.status) not in ('completed','cancelled','closed - paid','closed - pending payment')
          and (j.assigned_to = v_staff or j.team_leader = v_staff or coalesce(j.assigned_employees, '[]'::jsonb) ? (v_staff::text))
      ),
      'todaysScheduledJobs', (
        select count(*) from public.jobs j
        where j.deleted_at is null
          and v_staff is not null
          and lower(j.status) not in ('completed','cancelled','closed - paid','closed - pending payment')
          and coalesce(j.planned_start_date, j.job_date) = current_date
          and (j.assigned_to = v_staff or j.team_leader = v_staff or coalesce(j.assigned_employees, '[]'::jsonb) ? (v_staff::text))
      ),
      'myPendingClaims', (
        select coalesce(sum(e.amount), 0) from public.expenses e
        where e.deleted_at is null
          and v_staff is not null
          and e.employee_id = v_staff
          and lower(e.status) in ('submitted','pending approval')
      ),
      'myOpenAdvanceBalance', (
        select coalesce(sum(a.balance), 0) from public.advances a
        where a.deleted_at is null
          and v_staff is not null
          and a.staff_id = v_staff
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
