-- ============================================================================
-- Close direct-write gaps found in the role audit
-- ============================================================================
-- Row-level security decides WHICH rows a person may edit; these triggers decide
-- WHAT they may change, so the rules hold even when someone calls the API
-- directly instead of using the screens.
--
--   expenses           only Admin approves/rejects; only Finance/Admin pays, and
--                      only an approved expense; nobody reviews their own claim;
--                      staff create drafts/submitted claims only and cannot edit
--                      one after it is approved.
--   invoices           amount received changes only through recorded payments;
--                      the total cannot drop below what was already received.
--   material_requests  only Admin approves, rejects or issues.
--   service_reports    only Admin reviews, approves or rejects.
--
-- Triggers skip when auth.uid() is null (migrations, cron, seed scripts).

-- 1. Expenses ----------------------------------------------------------------------
create or replace function public.guard_expense_status()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_new text := lower(coalesce(new.status, 'draft'));
  v_old text := case when tg_op = 'UPDATE' then lower(coalesce(old.status, '')) end;
begin
  if auth.uid() is null then return new; end if;

  if tg_op = 'INSERT' then
    if not public.is_finance() then
      if v_new not in ('draft', 'submitted') then
        raise exception 'A new expense starts as a draft or a submitted claim.' using errcode = '42501';
      end if;
      new.approved_by := null; new.approved_at := null; new.reimbursed_at := null;
    end if;
    return new;
  end if;

  -- Staff cannot change an expense once the manager has decided on it.
  if not public.is_finance() and v_old not in ('draft', 'submitted', 'rejected') then
    raise exception 'This expense is already %. Ask finance if it needs a change.', old.status using errcode = '42501';
  end if;

  if new.status is distinct from old.status then
    if v_new in ('approved', 'rejected') then
      if not public.is_admin() then
        raise exception 'Only a manager can approve or reject expenses.' using errcode = '42501';
      end if;
      if new.employee_id is not null and new.employee_id = public.current_staff_id() then
        raise exception 'You cannot approve or reject your own expenses.' using errcode = '42501';
      end if;
    elsif v_new = 'paid' then
      if not public.is_finance() then
        raise exception 'Only finance can record a reimbursement.' using errcode = '42501';
      end if;
      if v_old <> 'approved' then
        raise exception 'Only an approved expense can be paid (this one is %).', old.status using errcode = '42501';
      end if;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_expenses_status_guard on public.expenses;
create trigger trg_expenses_status_guard
before insert or update on public.expenses
for each row execute function public.guard_expense_status();

-- 2. Invoices ----------------------------------------------------------------------
create or replace function public.guard_invoice_received()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_paid numeric;
begin
  if auth.uid() is null then return new; end if;
  if tg_op = 'INSERT' then
    if coalesce(new.amount_received, 0) <> 0 then
      raise exception 'Record customer payments on the invoice; the amount received cannot be typed in.' using errcode = '42501';
    end if;
    return new;
  end if;

  if new.amount_received is distinct from old.amount_received then
    -- An increase must be covered by payments recorded in this same transaction
    -- (now() is the transaction start, the payments' created_at default).
    -- Checking the change, not the total, keeps older invoices working.
    select coalesce(sum(amount), 0) into v_paid
    from public.invoice_payments where invoice_id = new.id and created_at = now();
    if new.amount_received - coalesce(old.amount_received, 0) > v_paid then
      raise exception 'Record customer payments on the invoice; the amount received cannot be typed in.' using errcode = '42501';
    end if;
    if new.amount_received < old.amount_received and not public.is_finance() then
      raise exception 'Only finance can reduce the amount received on an invoice.' using errcode = '42501';
    end if;
  end if;

  if new.total is distinct from old.total and coalesce(new.total, 0) < coalesce(new.amount_received, 0) then
    raise exception 'The invoice total cannot be less than the % already received.', new.amount_received using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_invoices_received_guard on public.invoices;
create trigger trg_invoices_received_guard            -- runs before trg_invoices_zz_payment_status
before insert or update on public.invoices
for each row execute function public.guard_invoice_received();

-- 3. Material requests -----------------------------------------------------------------
create or replace function public.guard_material_request_status()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_open constant text[] := array['draft', 'pending', 'pending approval', 'cancelled'];
begin
  if auth.uid() is null or public.is_admin() then return new; end if;
  if tg_op = 'INSERT' then
    if lower(coalesce(new.status, 'pending')) <> all (v_open) then
      raise exception 'A new material request waits for manager approval.' using errcode = '42501';
    end if;
    return new;
  end if;
  if lower(coalesce(old.status, '')) <> all (v_open) then
    raise exception 'This request is already %. Ask the manager if it needs a change.', old.status using errcode = '42501';
  end if;
  if lower(coalesce(new.status, '')) <> all (v_open) then
    raise exception 'Only a manager can approve, reject or issue material requests.' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_material_requests_status_guard on public.material_requests;
create trigger trg_material_requests_status_guard
before insert or update on public.material_requests
for each row execute function public.guard_material_request_status();

-- 4. Service reports ----------------------------------------------------------------------
create or replace function public.guard_service_report_status()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_staff constant text[] := array['draft', 'submitted'];
begin
  if auth.uid() is null or public.is_admin() then return new; end if;
  if tg_op = 'INSERT' then
    if lower(coalesce(new.status, 'draft')) <> all (v_staff) then
      raise exception 'A new service report starts as a draft or is submitted for review.' using errcode = '42501';
    end if;
    return new;
  end if;
  if new.status is distinct from old.status and lower(coalesce(new.status, '')) <> all (v_staff) then
    raise exception 'Only a manager can review, approve or reject service reports.' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_service_reports_status_guard on public.service_reports;
create trigger trg_service_reports_status_guard
before insert or update on public.service_reports
for each row execute function public.guard_service_report_status();

-- 5. Cash entries export: job order -----------------------------------------------------
create or replace view public.v_cash_entries
with (security_invoker = true) as
select ce.id, ce.number, ce.type, ce.date, ce.account, ce.reference_type, ce.source_id,
  ce.job_id, ce.counterparty, ce.amount, ce.method, ce.description, ce.attachment,
  ce.status, ce.posted_at, ce.created_by, ce.created_at, ce.updated_at,
  ce.deleted_at, ce.deleted_by,
  j.number as job_order
from public.cash_entries ce
left join public.jobs j on j.id = ce.job_id
where ce.deleted_at is null;
grant select on public.v_cash_entries to authenticated;

-- 6. Version ---------------------------------------------------------------------------------
create or replace function public.schema_version()
returns text language sql immutable as $$ select '20261130000000'::text $$;
grant execute on function public.schema_version() to anon, authenticated;
