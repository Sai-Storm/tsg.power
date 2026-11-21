-- ============================================================================
-- Finance: cash board, invoice amounts and job-order links
-- ============================================================================
-- Business rules
--   Cash IN  (company cash/bank):
--     * invoice payments (customer receipts against an invoice)
--     * posted cash entries of type Receipt (other income, advance returns,
--       job-closure receipts without an invoice)
--   Cash OUT:
--     * posted cash entries of type Payment (salaries are posted here by the
--       salary-paid trigger, plus any manual payments)
--     * expense claims marked Paid, except those funded from a staff advance
--       (the advance itself was already paid out)
--     * staff advances when they are issued
--   Monthly opening balance = settings.opening_cash_balance + all movements
--   before the month; closing = opening + cash in - cash out.
--   Accounts receivable (AR) at a date = issued invoices up to that date minus
--   payments received up to that date.
--   Invoice status follows its amounts: outstanding 0 -> Paid, part paid ->
--   Partially paid.
--
-- Idempotent: safe to run more than once.

-- 1. Invoice status follows received / outstanding -------------------------
create or replace function public.sync_invoice_payment_status()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if lower(coalesce(new.status, '')) in ('draft', 'cancelled', 'void') then
    return new;
  end if;
  if coalesce(new.total, 0) > 0 and coalesce(new.amount_received, 0) >= new.total then
    new.status := 'Paid';
  elsif coalesce(new.amount_received, 0) > 0 then
    new.status := 'Partially paid';
  elsif lower(coalesce(new.status, '')) in ('paid', 'partially paid') then
    new.status := 'Unpaid';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_invoices_zz_payment_status on public.invoices;
create trigger trg_invoices_zz_payment_status
  before insert or update of total, amount_received, status on public.invoices
  for each row execute function public.sync_invoice_payment_status();

-- 2. Invoice view: job order + invoice / received / outstanding amounts ------
drop view if exists public.v_invoices;
create view public.v_invoices
with (security_invoker = true) as
select i.*,
  c.name as customer,
  i.date as issued,
  public.money(i.total) as amount,
  c.name as customer_name,
  c.billing_address as customer_address,
  coalesce(nullif(i.attention, ''), c.contact_person) as customer_contact,
  j.number as job_number,
  j.number as job_order,
  j.title as job_title,
  public.format_machine_label(j.machine_id, j.equipment_type, j.equipment_model, j.serial_number) as machine_label,
  public.money(i.total) as invoice_amount,
  public.money(i.amount_received) as received,
  public.money(greatest(i.total - i.amount_received, 0)) as outstanding,
  greatest(i.total - i.amount_received, 0) as outstanding_value
from public.invoices i
left join public.customers c on c.id = i.customer_id
left join public.jobs j on j.id = i.job_id
where i.deleted_at is null;

grant select on public.v_invoices to authenticated;

-- 3. Cash movements (internal; used by cash_board and dashboard_summary) ----
create or replace function public.cash_movements(p_from date, p_to date)
returns table (
  entry_date date, source text, reference text, category text, job_number text,
  party text, description text, cash_in numeric, cash_out numeric
)
language sql
stable
security definer
set search_path = public
as $$
  select m.* from (
    select ip.date, 'Invoice receipt'::text, i.number, 'Invoice receipt'::text, j.number,
           c.name, concat_ws(' · ', ip.method, nullif(ip.notes, '')), ip.amount, 0::numeric
    from public.invoice_payments ip
    join public.invoices i on i.id = ip.invoice_id and i.deleted_at is null
    left join public.jobs j on j.id = i.job_id
    left join public.customers c on c.id = i.customer_id
    union all
    select ce.date,
           case when lower(ce.type) = 'receipt' then 'Other income' else 'Cash payment' end,
           ce.number,
           coalesce(nullif(ce.reference_type, ''), case when lower(ce.type) = 'receipt' then 'Other income' else 'Cash payment' end),
           j.number, coalesce(ce.counterparty, ce.account), ce.description,
           case when lower(ce.type) = 'receipt' then ce.amount else 0 end,
           case when lower(ce.type) = 'receipt' then 0 else ce.amount end
    from public.cash_entries ce
    left join public.jobs j on j.id = ce.job_id
    where ce.deleted_at is null and lower(ce.status) = 'posted' and lower(ce.type) in ('receipt', 'payment')
    union all
    select coalesce(e.reimbursed_at::date, e.date), 'Expense', e.number, 'Expense · ' || e.category, j.number,
           coalesce(st.name, e.supplier_name, 'Expense'), e.description, 0, e.amount
    from public.expenses e
    left join public.jobs j on j.id = e.job_id
    left join public.staff st on st.id = e.employee_id
    where e.deleted_at is null and lower(e.status) = 'paid'
      and coalesce(e.payment_source, '') not ilike '%advance%'
    union all
    select a.issued_on, 'Staff advance', a.number, 'Staff advance', j.number, st.name, a.purpose, 0, a.amount
    from public.advances a
    left join public.jobs j on j.id = a.job_id
    left join public.staff st on st.id = a.staff_id
    where a.deleted_at is null and a.issued_on is not null
      and lower(a.status) not in ('rejected', 'cancelled', 'pending approval', 'approved')
  ) as m(entry_date, source, reference, category, job_number, party, description, cash_in, cash_out)
  where (p_from is null or m.entry_date >= p_from)
    and (p_to is null or m.entry_date <= p_to);
$$;

revoke all on function public.cash_movements(date, date) from public, anon, authenticated;

-- 4. Cash board (admin) -------------------------------------------------------
create or replace function public.cash_board(p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_setting numeric := 0;
  v_opening numeric := 0;
  v_ar_date date;
begin
  if not public.is_admin() then
    raise exception 'Only administrators can view the cash board' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 400 then
    raise exception 'Choose a date range of up to one year';
  end if;

  select coalesce(nullif(regexp_replace(value, '[^0-9.-]', '', 'g'), '')::numeric, 0) into v_setting
  from public.settings where key = 'opening_cash_balance';
  v_setting := coalesce(v_setting, 0);
  v_opening := v_setting + coalesce((select sum(cash_in - cash_out) from public.cash_movements(null, p_from - 1)), 0);
  v_ar_date := least(p_to, current_date);

  return jsonb_build_object(
    'from', p_from,
    'to', p_to,
    'starting_balance', v_setting,
    'opening', v_opening,
    'income', coalesce((select sum(cash_in) from public.cash_movements(p_from, p_to)), 0),
    'expense', coalesce((select sum(cash_out) from public.cash_movements(p_from, p_to)), 0),

    'ledger', coalesce((
      select jsonb_agg(jsonb_build_object(
        'date', m.entry_date, 'source', m.source, 'reference', m.reference, 'category', m.category,
        'job_number', m.job_number, 'party', m.party, 'description', m.description,
        'cash_in', m.cash_in, 'cash_out', m.cash_out
      ) order by m.entry_date, m.cash_out, m.reference)
      from public.cash_movements(p_from, p_to) m
    ), '[]'::jsonb),

    'months', coalesce((
      select jsonb_agg(jsonb_build_object(
        'month', to_char(mo.m, 'YYYY-MM'),
        'opening', v_setting + coalesce((select sum(cash_in - cash_out) from public.cash_movements(null, (mo.m - interval '1 day')::date)), 0),
        'income', coalesce((select sum(cash_in) from public.cash_movements(mo.m::date, (mo.m + interval '1 month - 1 day')::date)), 0),
        'expense', coalesce((select sum(cash_out) from public.cash_movements(mo.m::date, (mo.m + interval '1 month - 1 day')::date)), 0),
        'invoiced', coalesce((
          select sum(i.total) from public.invoices i
          where i.deleted_at is null and lower(i.status) not in ('draft', 'cancelled', 'void')
            and i.date >= mo.m::date and i.date < (mo.m + interval '1 month')::date
        ), 0),
        'collected', coalesce((
          select sum(ip.amount) from public.invoice_payments ip
          join public.invoices i on i.id = ip.invoice_id and i.deleted_at is null
          where ip.date >= mo.m::date and ip.date < (mo.m + interval '1 month')::date
        ), 0),
        'receivable', coalesce((
          select sum(i.total) from public.invoices i
          where i.deleted_at is null and lower(i.status) not in ('draft', 'cancelled', 'void')
            and i.date < (mo.m + interval '1 month')::date
        ), 0) - coalesce((
          select sum(ip.amount) from public.invoice_payments ip
          join public.invoices i on i.id = ip.invoice_id and i.deleted_at is null
          where lower(i.status) not in ('draft', 'cancelled', 'void')
            and ip.date < (mo.m + interval '1 month')::date
        ), 0)
      ) order by mo.m)
      from generate_series(date_trunc('month', p_from), date_trunc('month', p_to), interval '1 month') as mo(m)
    ), '[]'::jsonb),

    'receivables', coalesce((
      select jsonb_agg(r order by r->>'due_date' nulls last, r->>'number')
      from (
        select jsonb_build_object(
          'number', i.number, 'job_number', j.number, 'customer', c.name,
          'date', i.date, 'due_date', i.due_date, 'total', i.total,
          'received', coalesce(p.received, 0),
          'outstanding', i.total - coalesce(p.received, 0),
          'days_overdue', case when i.due_date is not null and i.due_date < v_ar_date then v_ar_date - i.due_date else 0 end
        ) as r
        from public.invoices i
        left join public.jobs j on j.id = i.job_id
        left join public.customers c on c.id = i.customer_id
        left join lateral (
          select sum(ip.amount) as received from public.invoice_payments ip
          where ip.invoice_id = i.id and ip.date <= v_ar_date
        ) p on true
        where i.deleted_at is null and lower(i.status) not in ('draft', 'cancelled', 'void')
          and i.date <= v_ar_date
          and i.total - coalesce(p.received, 0) > 0
      ) rcv
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.cash_board(date, date) from public, anon;
grant execute on function public.cash_board(date, date) to authenticated;

-- 5. Advance settlement: returned cash goes back into the cash book ----------
create or replace function public.settle_advance(p_advance uuid, p_amount numeric)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.advances;
  v_before numeric;
  v_returned numeric;
begin
  if not public.is_admin() then
    raise exception 'Only administrators can settle advances' using errcode = '42501';
  end if;
  select claimed into v_before from public.advances where id = p_advance and deleted_at is null;
  update public.advances set
    claimed = least(amount, claimed + coalesce(p_amount, 0)),
    status = case when least(amount, claimed + coalesce(p_amount, 0)) >= amount then 'Settled' else 'Partially Settled' end,
    settled_at = case when least(amount, claimed + coalesce(p_amount, 0)) >= amount then now() else settled_at end
  where id = p_advance and deleted_at is null
  returning * into v_row;
  if v_row.id is null then
    raise exception 'Advance not found';
  end if;

  v_returned := v_row.claimed - coalesce(v_before, 0);
  if v_returned > 0 then
    insert into public.cash_entries (type, date, account, reference_type, source_id, job_id, counterparty, amount, method, description, status, posted_at, created_by)
    values (
      'Receipt', current_date, 'Cash', 'Advance return', v_row.id::text, v_row.job_id,
      (select name from public.staff where id = v_row.staff_id), v_returned, 'Cash',
      'Cash returned for advance ' || coalesce(v_row.number, ''), 'Posted', now(), auth.uid()
    );
  end if;
  return to_jsonb(v_row);
end;
$$;

-- 6. Job closure payment is applied to the job's invoice ---------------------
create or replace function public.close_job(p_job uuid, p_payment_status text, p_payment_amount numeric, p_due_date date)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.jobs;
  v_invoice uuid;
  v_left numeric := coalesce(p_payment_amount, 0);
  v_apply numeric;
  v_inv record;
begin
  if not (
    public.is_admin()
    or public.is_job_member(p_job)
    or exists (select 1 from public.jobs j where j.id = p_job and j.created_by = auth.uid())
  ) then
    raise exception 'Not authorized to close this job' using errcode = '42501';
  end if;

  update public.jobs set
    status = case when lower(coalesce(p_payment_status, '')) = 'paid' then 'Closed - Paid' else 'Closed - Pending Payment' end,
    closed_at = now()
  where id = p_job and deleted_at is null
  returning * into v_row;

  if v_row.id is null then
    raise exception 'Job not found';
  end if;

  -- Apply the payment to the job's open invoices (oldest first).
  for v_inv in
    select id, total - amount_received as due from public.invoices
    where job_id = p_job and deleted_at is null
      and lower(status) not in ('draft', 'cancelled', 'void')
      and total - amount_received > 0
    order by date, created_at
  loop
    exit when v_left <= 0;
    v_apply := least(v_left, v_inv.due);
    insert into public.invoice_payments (invoice_id, amount, date, method, notes, created_by)
    values (v_inv.id, v_apply, current_date, 'Cash', 'Received at job closure', auth.uid());
    update public.invoices set amount_received = amount_received + v_apply where id = v_inv.id;
    v_left := v_left - v_apply;
  end loop;

  -- Anything not covered by an invoice is recorded as other income.
  if v_left > 0 then
    insert into public.cash_entries (type, date, account, reference_type, source_id, job_id, counterparty, amount, method, description, status, posted_at, created_by)
    values (
      'Receipt', current_date, 'Cash', 'Job', p_job::text, p_job,
      (select coalesce(c.name, 'Customer') from public.jobs j left join public.customers c on c.id = j.customer_id where j.id = p_job),
      v_left, 'Cash', 'Job closure payment', 'Posted', now(), auth.uid()
    );
  end if;

  return to_jsonb(v_row);
end;
$$;

-- 7. Payments recorded on an invoice keep the status in sync via the trigger;
--    record_invoice_payment no longer needs to set it.
create or replace function public.record_invoice_payment(p_invoice uuid, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_amount numeric := coalesce(nullif(p_payload->>'amount', '')::numeric, 0);
  v_invoice public.invoices;
  v_due numeric;
begin
  if not (public.is_staff() or public.is_admin()) then
    raise exception 'Not authorized to record payments' using errcode = '42501';
  end if;
  if v_amount <= 0 then
    raise exception 'Payment amount must be greater than zero';
  end if;
  select total - amount_received into v_due from public.invoices where id = p_invoice and deleted_at is null;
  if v_due is null then
    raise exception 'Invoice not found';
  end if;
  if v_amount > v_due then
    raise exception 'Payment is more than the outstanding balance (%)', v_due;
  end if;

  insert into public.invoice_payments (invoice_id, amount, date, method, notes, created_by)
  values (
    p_invoice, v_amount,
    coalesce(nullif(p_payload->>'date', '')::date, current_date),
    coalesce(nullif(p_payload->>'method', ''), 'Cash'),
    p_payload->>'notes', auth.uid()
  );

  update public.invoices set amount_received = amount_received + v_amount
  where id = p_invoice
  returning * into v_invoice;
  return to_jsonb(v_invoice);
end;
$$;

-- 8. Expense & claims list: job order is already exposed as job_order.

-- 9. Dashboard: net cash balance uses the same cash rules as the cash board ---
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

  select coalesce(nullif(regexp_replace(value, '[^0-9.-]', '', 'g'), '')::numeric, 0) into v_opening
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
      'netCashBalance', v_opening + coalesce((select sum(cash_in - cash_out) from public.cash_movements(null, null)), 0),
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
