-- Business workflow RPCs. These are SECURITY DEFINER functions because some
-- transitions must write rows that staff cannot touch directly (payments,
-- stock movements, status transitions). Every function re-checks the caller.

------------------------------------------------------------------
-- Notifications
------------------------------------------------------------------
create or replace function public.notify_admins(p_title text, p_details text, p_related text)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.notifications (user_id, title, details, related_to)
  select p.id, p_title, p_details, p_related
  from public.profiles p
  where lower(p.role) = 'admin' and p.is_active;
$$;

create or replace function public.notify_staff(p_staff uuid, p_title text, p_details text, p_related text)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.notifications (user_id, title, details, related_to)
  select s.profile_id, p_title, p_details, p_related
  from public.staff s
  where s.id = p_staff and s.profile_id is not null;
$$;

create or replace function public.trg_notify_admin_on_request()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.notify_admins('Material request submitted', coalesce(new.note, 'A new material request is awaiting approval.'), new.number);
  return new;
end;
$$;

create or replace function public.trg_notify_admin_on_expense()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.notify_admins('Expense claim submitted', coalesce(new.description, 'A new expense claim is awaiting approval.'), new.number);
  return new;
end;
$$;

create or replace function public.trg_notify_admin_on_advance()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.notify_admins('Advance requested', coalesce(new.purpose, 'A new staff advance is awaiting approval.'), new.number);
  return new;
end;
$$;

create or replace function public.trg_notify_staff_on_job()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.assigned_to is not null then
    if tg_op = 'INSERT' then
      perform public.notify_staff(new.assigned_to, 'Job assigned', coalesce(new.title, 'You have been assigned a job order.'), new.number);
    elsif new.assigned_to is distinct from old.assigned_to then
      perform public.notify_staff(new.assigned_to, 'Job assigned', coalesce(new.title, 'You have been assigned a job order.'), new.number);
    end if;
  end if;
  return new;
end;
$$;

create trigger trg_material_requests_notify after insert on public.material_requests
  for each row execute function public.trg_notify_admin_on_request();
create trigger trg_expenses_notify after insert on public.expenses
  for each row execute function public.trg_notify_admin_on_expense();
create trigger trg_advances_notify after insert on public.advances
  for each row execute function public.trg_notify_admin_on_advance();
create trigger trg_jobs_notify after insert or update of assigned_to on public.jobs
  for each row execute function public.trg_notify_staff_on_job();

------------------------------------------------------------------
-- Salary paid -> cash book
------------------------------------------------------------------
create or replace function public.trg_salary_paid()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text;
  v_amount numeric := greatest(coalesce(new.basic_salary, 0) + coalesce(new.allowances, 0) - coalesce(new.deductions, 0), 0);
begin
  if lower(coalesce(new.status, '')) = 'paid' and lower(coalesce(old.status, '')) <> 'paid' then
    select name into v_name from public.staff where id = new.staff_id;
    if new.paid_on is null then
      new.paid_on := current_date;
    end if;
    if v_amount > 0 then
      insert into public.cash_entries (type, date, account, reference_type, source_id, counterparty, amount, method, description, status, posted_at, created_by)
      values (
        'Payment', coalesce(new.paid_on, current_date), 'Bank', 'Salary', new.id::text,
        coalesce(v_name, 'Staff member'), v_amount, coalesce(new.payment_method, 'Bank transfer'),
        'Salary ' || new.salary_month, 'Posted', now(), auth.uid()
      );
    end if;
  end if;
  return new;
end;
$$;

create trigger trg_salaries_paid before update of status on public.salaries
  for each row execute function public.trg_salary_paid();

------------------------------------------------------------------
-- Approved service report completes its job
------------------------------------------------------------------
create or replace function public.trg_service_report_approved()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if lower(coalesce(new.status, '')) = 'approved' and lower(coalesce(old.status, '')) <> 'approved' and new.job_id is not null then
    update public.jobs set status = 'Completed' where id = new.job_id;
  end if;
  return new;
end;
$$;

create trigger trg_service_reports_approved after update of status on public.service_reports
  for each row execute function public.trg_service_report_approved();

------------------------------------------------------------------
-- Jobs
------------------------------------------------------------------
create or replace function public.set_job_status(p_job uuid, p_status text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.jobs;
begin
  if not (public.is_admin() or public.is_job_member(p_job)) then
    raise exception 'Not authorized to update this job' using errcode = '42501';
  end if;
  if p_status is null or p_status = '' then
    raise exception 'Status is required';
  end if;
  if not public.is_admin() and lower(p_status) not in ('in progress', 'on hold', 'completed') then
    raise exception 'Staff can only update work progress' using errcode = '42501';
  end if;
  update public.jobs set status = p_status where id = p_job and deleted_at is null returning * into v_row;
  if v_row.id is null then
    raise exception 'Job not found';
  end if;
  return to_jsonb(v_row);
end;
$$;

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
  if not public.is_admin() then
    raise exception 'Only administrators can assign jobs' using errcode = '42501';
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
    status = case when lower(status) in ('draft', 'pending approval', 'approved', 'assigned', 'scheduled') then v_status else status end
  where id = p_job and deleted_at is null
  returning * into v_row;

  if v_row.id is null then
    raise exception 'Job not found';
  end if;
  return to_jsonb(v_row);
end;
$$;

create or replace function public.close_job(p_job uuid, p_payment_status text, p_payment_amount numeric, p_due_date date)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.jobs;
begin
  if not public.is_admin() then
    raise exception 'Only administrators can close jobs' using errcode = '42501';
  end if;

  update public.jobs set
    status = case when lower(coalesce(p_payment_status, '')) = 'paid' then 'Closed - Paid' else 'Closed - Pending Payment' end,
    closed_at = now()
  where id = p_job and deleted_at is null
  returning * into v_row;

  if v_row.id is null then
    raise exception 'Job not found';
  end if;

  if coalesce(p_payment_amount, 0) > 0 then
    insert into public.cash_entries (type, date, account, reference_type, source_id, job_id, counterparty, amount, method, description, status, posted_at, created_by)
    values (
      'Receipt', current_date, 'Cash', 'Job', p_job::text, p_job,
      (select coalesce(c.name, 'Customer') from public.jobs j left join public.customers c on c.id = j.customer_id where j.id = p_job),
      p_payment_amount, 'Cash', 'Job closure payment', 'Posted', now(), auth.uid()
    );
  end if;

  return to_jsonb(v_row);
end;
$$;

create or replace function public.submit_service_report(p_job uuid, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.service_reports;
begin
  if not (public.is_admin() or public.is_job_member(p_job)) then
    raise exception 'Not authorized to submit a report for this job' using errcode = '42501';
  end if;

  insert into public.service_reports (
    job_id, service_date, started_at, finished_at, technicians, customer_complaint,
    findings, work_done, parts_used, test_results, recommendations, attachments,
    customer_representative, customer_acceptance, acceptance_notes,
    technician_signature, customer_signature, status, submitted_by
  ) values (
    p_job,
    coalesce(nullif(p_payload->>'service_date', '')::date, current_date),
    nullif(p_payload->>'started_at', '')::timestamptz,
    nullif(p_payload->>'finished_at', '')::timestamptz,
    coalesce(p_payload->'technicians', '[]'::jsonb),
    p_payload->>'customer_complaint',
    p_payload->>'findings',
    p_payload->>'work_done',
    coalesce(p_payload->'parts_used', '[]'::jsonb),
    p_payload->>'test_results',
    p_payload->>'recommendations',
    coalesce(p_payload->'attachments', '[]'::jsonb),
    p_payload->>'customer_representative',
    p_payload->>'customer_acceptance',
    p_payload->>'acceptance_notes',
    p_payload->>'technician_signature',
    p_payload->>'customer_signature',
    coalesce(nullif(p_payload->>'status', ''), 'Submitted'),
    auth.uid()
  )
  returning * into v_row;

  perform public.notify_admins('Completion report submitted', 'A service report was submitted for review.', v_row.number);
  return to_jsonb(v_row);
end;
$$;

------------------------------------------------------------------
-- Invoices
------------------------------------------------------------------
create or replace function public.record_invoice_payment(p_invoice uuid, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_amount numeric := coalesce(nullif(p_payload->>'amount', '')::numeric, 0);
  v_invoice public.invoices;
begin
  if not public.is_admin() then
    raise exception 'Only administrators can record payments' using errcode = '42501';
  end if;
  if v_amount <= 0 then
    raise exception 'Payment amount must be greater than zero';
  end if;

  insert into public.invoice_payments (invoice_id, amount, date, method, notes, created_by)
  values (
    p_invoice, v_amount,
    coalesce(nullif(p_payload->>'date', '')::date, current_date),
    coalesce(nullif(p_payload->>'method', ''), 'Cash'),
    p_payload->>'notes', auth.uid()
  );

  update public.invoices set
    amount_received = amount_received + v_amount,
    status = case
      when amount_received + v_amount >= total then 'Paid'
      when amount_received + v_amount > 0 then 'Partially paid'
      else status
    end
  where id = p_invoice and deleted_at is null
  returning * into v_invoice;

  if v_invoice.id is null then
    raise exception 'Invoice not found';
  end if;
  return to_jsonb(v_invoice);
end;
$$;

------------------------------------------------------------------
-- Expenses, advances and cash entries
------------------------------------------------------------------
create or replace function public.set_expense_status(p_expense uuid, p_status text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.expenses;
begin
  if not public.is_admin() then
    raise exception 'Only administrators can review expenses' using errcode = '42501';
  end if;

  update public.expenses set
    status = p_status,
    approved_by = case when lower(coalesce(p_status, '')) in ('approved', 'paid') then auth.uid() else approved_by end,
    approved_at = case when lower(coalesce(p_status, '')) in ('approved', 'paid') then now() else approved_at end,
    reimbursed_at = case when lower(coalesce(p_status, '')) = 'paid' then now() else reimbursed_at end
  where id = p_expense and deleted_at is null
  returning * into v_row;

  if v_row.id is null then
    raise exception 'Expense not found';
  end if;
  return to_jsonb(v_row);
end;
$$;

create or replace function public.set_advance_status(p_advance uuid, p_status text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.advances;
begin
  if not public.is_admin() then
    raise exception 'Only administrators can review advances' using errcode = '42501';
  end if;
  update public.advances set status = p_status where id = p_advance and deleted_at is null returning * into v_row;
  if v_row.id is null then
    raise exception 'Advance not found';
  end if;
  return to_jsonb(v_row);
end;
$$;

create or replace function public.issue_advance(p_advance uuid, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.advances;
begin
  if not public.is_admin() then
    raise exception 'Only administrators can issue advances' using errcode = '42501';
  end if;
  update public.advances set
    status = 'Issued',
    issued_on = coalesce(nullif(p_payload->>'date', '')::date, current_date),
    issued_by = auth.uid(),
    amount = coalesce(nullif(p_payload->>'amount', '')::numeric, amount)
  where id = p_advance and deleted_at is null
  returning * into v_row;
  if v_row.id is null then
    raise exception 'Advance not found';
  end if;
  return to_jsonb(v_row);
end;
$$;

create or replace function public.claim_advance(p_advance uuid, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_advance public.advances;
  v_expense public.expenses;
  v_amount numeric := coalesce(nullif(p_payload->>'amount', '')::numeric, 0);
begin
  select * into v_advance from public.advances where id = p_advance and deleted_at is null;
  if v_advance.id is null then
    raise exception 'Advance not found';
  end if;
  if not (public.is_admin() or v_advance.staff_id = public.current_staff_id()) then
    raise exception 'Not authorized to claim this advance' using errcode = '42501';
  end if;
  if v_amount <= 0 then
    raise exception 'Claim amount must be greater than zero';
  end if;

  insert into public.expenses (category, job_id, employee_id, date, amount, description, payment_source, advance_id, status, created_by)
  values (
    coalesce(nullif(p_payload->>'category', ''), 'Job'),
    v_advance.job_id,
    v_advance.staff_id,
    coalesce(nullif(p_payload->>'date', '')::date, current_date),
    v_amount,
    coalesce(nullif(p_payload->>'description', ''), 'Advance settlement claim'),
    'From advance',
    p_advance,
    'Submitted',
    auth.uid()
  )
  returning * into v_expense;

  update public.advances set
    claimed = claimed + v_amount,
    status = case when claimed + v_amount >= amount then 'Settled' else 'Partially Settled' end,
    settled_at = case when claimed + v_amount >= amount then now() else settled_at end
  where id = p_advance;

  return to_jsonb(v_expense);
end;
$$;

create or replace function public.settle_advance(p_advance uuid, p_amount numeric)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.advances;
begin
  if not public.is_admin() then
    raise exception 'Only administrators can settle advances' using errcode = '42501';
  end if;
  update public.advances set
    claimed = least(amount, claimed + coalesce(p_amount, 0)),
    status = case when least(amount, claimed + coalesce(p_amount, 0)) >= amount then 'Settled' else 'Partially Settled' end,
    settled_at = case when least(amount, claimed + coalesce(p_amount, 0)) >= amount then now() else settled_at end
  where id = p_advance and deleted_at is null
  returning * into v_row;
  if v_row.id is null then
    raise exception 'Advance not found';
  end if;
  return to_jsonb(v_row);
end;
$$;

create or replace function public.set_cash_entry_status(p_entry uuid, p_status text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.cash_entries;
begin
  if not public.is_admin() then
    raise exception 'Only administrators can review cash entries' using errcode = '42501';
  end if;
  update public.cash_entries set
    status = p_status,
    posted_at = case when lower(coalesce(p_status, '')) = 'posted' then now() else posted_at end
  where id = p_entry and deleted_at is null
  returning * into v_row;
  if v_row.id is null then
    raise exception 'Cash entry not found';
  end if;
  return to_jsonb(v_row);
end;
$$;

------------------------------------------------------------------
-- Quotation -> job conversion
------------------------------------------------------------------
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
  if not public.is_admin() then
    raise exception 'Only administrators can convert quotations' using errcode = '42501';
  end if;
  select * into v_quote from public.quotations where id = p_quotation and deleted_at is null;
  if v_quote.id is null then
    raise exception 'Quotation not found';
  end if;

  insert into public.jobs (
    job_date, job_type, priority, status, customer_id, quotation_id, customer_approval,
    payment_terms, title, description, scope_of_work, job_amount, created_by
  ) values (
    current_date, v_quote.job_type, 'Normal', 'Pending Approval', v_quote.customer_id, v_quote.id, 'Accepted',
    v_quote.payment_terms, 'Service from ' || v_quote.number, v_quote.scope_of_work, v_quote.scope_of_work,
    v_quote.total, auth.uid()
  )
  returning * into v_job;

  update public.quotations set status = 'Converted to Job' where id = p_quotation;
  return to_jsonb(v_job);
end;
$$;

------------------------------------------------------------------
-- Stock movements
------------------------------------------------------------------
create or replace function public.stock_movement(p_request uuid, p_item uuid, p_type text, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item public.inventory_items;
  v_request public.material_requests;
  v_qty numeric := coalesce(nullif(p_payload->>'quantity', '')::numeric, 0);
begin
  if not public.is_admin() then
    raise exception 'Only administrators can move stock' using errcode = '42501';
  end if;
  if p_type not in ('issue', 'return', 'in', 'out') then
    raise exception 'Invalid stock movement type';
  end if;
  if v_qty <= 0 then
    raise exception 'Quantity must be greater than zero';
  end if;

  select * into v_item from public.inventory_items where id = p_item and deleted_at is null;
  if v_item.id is null then
    raise exception 'Inventory item not found';
  end if;
  select * into v_request from public.material_requests where id = p_request and deleted_at is null;

  if p_type in ('issue', 'out') and v_item.qty_on_hand < v_qty then
    raise exception 'Issue quantity exceeds available stock';
  end if;

  update public.inventory_items set
    qty_on_hand = case when p_type in ('issue', 'out') then qty_on_hand - v_qty else qty_on_hand + v_qty end
  where id = p_item
  returning * into v_item;

  insert into public.stock_movements (item_id, job_id, request_id, type, quantity, note, created_by)
  values (p_item, v_request.job_id, p_request, p_type, v_qty, p_payload->>'note', auth.uid());

  if v_request.id is not null then
    update public.material_requests set
      status = case
        when p_type = 'issue' then 'Issued'
        when p_type = 'return' then 'Issued'
        else status
      end
    where id = p_request;
  end if;

  return to_jsonb(v_item);
end;
$$;

------------------------------------------------------------------
-- Recycle bin
------------------------------------------------------------------
create or replace function public.soft_delete_record(p_resource text, p_id uuid, p_mode text default 'Restricted')
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_table text;
  v_module text := p_resource;
  v_title text;
  v_record jsonb;
  v_entry uuid;
begin
  if not public.is_admin() then
    raise exception 'Only administrators can delete records' using errcode = '42501';
  end if;

  if p_resource = 'cash-claims' then
    if exists (select 1 from public.expenses where id = p_id) then
      v_table := 'expenses';
    elsif exists (select 1 from public.advances where id = p_id) then
      v_table := 'advances';
      v_module := 'advances';
    elsif exists (select 1 from public.cash_entries where id = p_id) then
      v_table := 'cash_entries';
      v_module := 'cash_entries';
    end if;
  else
    v_table := case p_resource
      when 'customers' then 'customers'
      when 'quotations' then 'quotations'
      when 'jobs' then 'jobs'
      when 'service-reports' then 'service_reports'
      when 'machines' then 'machines'
      when 'inventory' then 'inventory_items'
      when 'material-requests' then 'material_requests'
      when 'suppliers' then 'suppliers'
      when 'invoices' then 'invoices'
      when 'my-expense-claims' then 'expenses'
      when 'expenses' then 'expenses'
      when 'advances' then 'advances'
      when 'my-advances' then 'advances'
      when 'fixed-assets' then 'fixed_assets'
      when 'staff' then 'staff'
      when 'salary' then 'salaries'
      when 'salaries' then 'salaries'
      when 'my-salary' then 'salaries'
      when 'cash_entries' then 'cash_entries'
      else null
    end;
  end if;
  if v_table is null then
    raise exception 'This record type cannot be deleted';
  end if;

  v_title := case p_resource
    when 'customers' then 'Customers'
    when 'quotations' then 'Quotations'
    when 'jobs' then 'Job orders'
    when 'service-reports' then 'Service reports'
    when 'machines' then 'Machines'
    when 'inventory' then 'Inventory'
    when 'material-requests' then 'Material requests'
    when 'suppliers' then 'Suppliers'
    when 'invoices' then 'Invoices'
    when 'cash-claims' then 'Cash & claims'
    when 'my-expense-claims' then 'My expense claims'
    when 'expenses' then 'Cash & claims'
    when 'advances' then 'Cash & claims'
    when 'my-advances' then 'My advances'
    when 'fixed-assets' then 'Fixed assets'
    when 'staff' then 'Staff management'
    when 'salary' then 'Salary management'
    when 'salaries' then 'Salary management'
    when 'my-salary' then 'My salary'
    else p_resource
  end;

  execute format('select to_jsonb(t) from public.%I t where t.id = $1', v_table) into v_record using p_id;
  if v_record is null then
    raise exception 'Record not found';
  end if;

  insert into public.recycle_bin (module, module_title, record_id, record, deleted_by, deleted_by_name, deletion_mode)
  values (v_module, v_title, p_id, v_record, auth.uid(), (select name from public.profiles where id = auth.uid()), coalesce(p_mode, 'Restricted'))
  returning id into v_entry;

  execute format('update public.%I set deleted_at = now(), deleted_by = auth.uid() where id = $1', v_table) using p_id;
  return v_entry;
end;
$$;

create or replace function public.restore_recycle_entry(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_entry public.recycle_bin;
  v_table text;
begin
  if not public.is_admin() then
    raise exception 'Only administrators can restore records' using errcode = '42501';
  end if;
  select * into v_entry from public.recycle_bin where id = p_id;
  if v_entry.id is null then
    raise exception 'Recycle entry not found';
  end if;

  v_table := case v_entry.module
    when 'customers' then 'customers'
    when 'quotations' then 'quotations'
    when 'jobs' then 'jobs'
    when 'service-reports' then 'service_reports'
    when 'machines' then 'machines'
    when 'inventory' then 'inventory_items'
    when 'material-requests' then 'material_requests'
    when 'suppliers' then 'suppliers'
    when 'invoices' then 'invoices'
    when 'cash-claims' then 'expenses'
    when 'my-expense-claims' then 'expenses'
    when 'expenses' then 'expenses'
    when 'advances' then 'advances'
    when 'my-advances' then 'advances'
    when 'fixed-assets' then 'fixed_assets'
    when 'staff' then 'staff'
    when 'salary' then 'salaries'
    when 'salaries' then 'salaries'
    when 'my-salary' then 'salaries'
    when 'cash_entries' then 'cash_entries'
    else null
  end;
  if v_table is null then
    raise exception 'This record type cannot be restored';
  end if;

  execute format('update public.%I set deleted_at = null, deleted_by = null where id = $1', v_table) using v_entry.record_id;
  delete from public.recycle_bin where id = p_id;
end;
$$;

create or replace function public.purge_recycle_entry(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_entry public.recycle_bin;
  v_table text;
begin
  if not public.is_admin() then
    raise exception 'Only administrators can purge records' using errcode = '42501';
  end if;
  select * into v_entry from public.recycle_bin where id = p_id;
  if v_entry.id is null then
    raise exception 'Recycle entry not found';
  end if;

  v_table := case v_entry.module
    when 'customers' then 'customers'
    when 'quotations' then 'quotations'
    when 'jobs' then 'jobs'
    when 'service-reports' then 'service_reports'
    when 'machines' then 'machines'
    when 'inventory' then 'inventory_items'
    when 'material-requests' then 'material_requests'
    when 'suppliers' then 'suppliers'
    when 'invoices' then 'invoices'
    when 'cash-claims' then 'expenses'
    when 'my-expense-claims' then 'expenses'
    when 'expenses' then 'expenses'
    when 'advances' then 'advances'
    when 'my-advances' then 'advances'
    when 'fixed-assets' then 'fixed_assets'
    when 'staff' then 'staff'
    when 'salary' then 'salaries'
    when 'salaries' then 'salaries'
    when 'my-salary' then 'salaries'
    when 'cash_entries' then 'cash_entries'
    else null
  end;
  if v_table is null then
    raise exception 'This record type cannot be purged';
  end if;

  execute format('delete from public.%I where id = $1', v_table) using v_entry.record_id;
  delete from public.recycle_bin where id = p_id;
end;
$$;

------------------------------------------------------------------
-- Dashboard
------------------------------------------------------------------
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
grant execute on all functions in schema public to authenticated;
