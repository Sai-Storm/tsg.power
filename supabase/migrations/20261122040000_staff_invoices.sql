-- ============================================================================
-- Invoices move to Staff; Admin no longer works job orders
-- ============================================================================
-- Staff now generate invoices from completed jobs, issue them (no admin
-- approval step), record customer payments and close jobs. Admin keeps
-- read access to invoices and payments for financial reporting.
--
-- Idempotent: safe to run more than once.

-- Invoices: staff manage, admin keeps existing full access ------------------
drop policy if exists invoices_staff on public.invoices;
create policy invoices_staff on public.invoices
  for all to authenticated
  using (public.is_staff())
  with check (public.is_staff());

-- Invoice payments: staff read and add (via record_invoice_payment) --------
drop policy if exists invoice_payments_staff_read on public.invoice_payments;
create policy invoice_payments_staff_read on public.invoice_payments
  for select to authenticated
  using (public.is_staff());

-- Retire the invoice approval statuses
update public.invoices
set status = 'Draft'
where deleted_at is null and lower(status) in ('pending approval', 'approved');

-- Record payment: staff or admin ---------------------------------------------
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
  if not (public.is_staff() or public.is_admin()) then
    raise exception 'Not authorized to record payments' using errcode = '42501';
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

-- Close job: staff who created or work on the job ---------------------------
create or replace function public.close_job(p_job uuid, p_payment_status text, p_payment_amount numeric, p_due_date date)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.jobs;
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

grant execute on function public.record_invoice_payment(uuid, jsonb) to authenticated;
grant execute on function public.close_job(uuid, text, numeric, date) to authenticated;

-- Job status: staff can also mark a job "Invoice Generated" ------------------
create or replace function public.set_job_status(p_job uuid, p_status text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.jobs;
begin
  if not (
    public.is_admin()
    or public.is_job_member(p_job)
    or exists (select 1 from public.jobs j where j.id = p_job and j.created_by = auth.uid())
  ) then
    raise exception 'Not authorized to update this job' using errcode = '42501';
  end if;
  if p_status is null or p_status = '' then
    raise exception 'Status is required';
  end if;
  if not public.is_admin() and lower(p_status) not in ('in progress', 'on hold', 'completed', 'invoice generated') then
    raise exception 'Staff can only update work progress' using errcode = '42501';
  end if;
  update public.jobs set status = p_status where id = p_job and deleted_at is null returning * into v_row;
  if v_row.id is null then
    raise exception 'Job not found';
  end if;
  return to_jsonb(v_row);
end;
$$;

grant execute on function public.set_job_status(uuid, text) to authenticated;
