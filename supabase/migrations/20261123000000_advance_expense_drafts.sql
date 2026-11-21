-- ============================================================================
-- Advance expense drafts
-- ============================================================================
-- A staff member who receives an advance (e.g. 1,000,000 MMK) can record what
-- they spend from it as they go (SKU purchase 1: 300,000, purchase 2: 200,000,
-- ...) with receipts, WITHOUT submitting. Drafts:
--   * are saved as expenses with status 'Draft', linked to the advance;
--   * do not change the advance's claimed / balance figures;
--   * do not notify admins and cannot be approved;
--   * can be edited or deleted by their owner;
--   * can never add up to more than the advance amount.
-- The staff member can submit at any time (one draft, several, or all). On
-- submission the drafts become 'Submitted', the advance's claimed amount goes
-- up, the advance moves to Partially Settled / Settled, and admins get one
-- notification. If an admin later rejects an advance-funded expense, its
-- amount goes back to the advance balance.

-- 1. Admins are only notified about real (non-draft) claims ------------------
create or replace function public.trg_notify_admin_on_expense()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if lower(coalesce(new.status, '')) = 'draft' then
    return new;
  end if;
  perform public.notify_admins('Expense claim submitted', coalesce(new.description, 'A new expense claim is awaiting approval.'), new.number);
  return new;
end;
$$;

-- 2. Drafts only leave 'Draft' through submit_advance_drafts -----------------
create or replace function public.guard_expense_draft_submit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if lower(coalesce(old.status, '')) = 'draft'
     and lower(coalesce(new.status, '')) <> 'draft'
     and old.advance_id is not null
     and coalesce(current_setting('tsg.submitting_drafts', true), '') <> 'on' then
    raise exception 'Submit advance expenses from My advances → Expenses so the advance balance is updated.'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_expenses_draft_guard on public.expenses;
create trigger trg_expenses_draft_guard before update on public.expenses
  for each row execute function public.guard_expense_draft_submit();

-- Helper: load an advance the caller may record expenses against.
create or replace function public.advance_for_expenses(p_advance uuid)
returns public.advances
language plpgsql
security definer
set search_path = public
as $$
declare
  v_advance public.advances;
begin
  select * into v_advance from public.advances where id = p_advance and deleted_at is null;
  if v_advance.id is null then
    raise exception 'Advance not found';
  end if;
  if not (public.is_admin() or v_advance.staff_id = public.current_staff_id()) then
    raise exception 'Not authorized for this advance' using errcode = '42501';
  end if;
  return v_advance;
end;
$$;

-- 3. Summary + entries for one advance ---------------------------------------
create or replace function public.advance_expenses(p_advance uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_advance public.advances := public.advance_for_expenses(p_advance);
  v_drafts numeric;
begin
  select coalesce(sum(amount), 0) into v_drafts
  from public.expenses
  where advance_id = p_advance and deleted_at is null and lower(status) = 'draft';

  return jsonb_build_object(
    'advance', jsonb_build_object(
      'id', v_advance.id,
      'number', v_advance.number,
      'purpose', v_advance.purpose,
      'status', v_advance.status,
      'issued_on', v_advance.issued_on,
      'job_id', v_advance.job_id,
      'job_number', (select number from public.jobs where id = v_advance.job_id),
      'amount', v_advance.amount,
      'claimed', v_advance.claimed,
      'drafts', v_drafts,
      'remaining', greatest(v_advance.amount - v_advance.claimed - v_drafts, 0),
      'can_record', lower(v_advance.status) not in ('pending approval', 'approved', 'rejected', 'cancelled', 'settled')
    ),
    'entries', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', e.id,
        'number', e.number,
        'date', e.date,
        'category', e.category,
        'supplier_name', e.supplier_name,
        'description', e.description,
        'amount', e.amount,
        'status', e.status,
        'receipt_file', e.receipt_file,
        'created_at', e.created_at
      ) order by (lower(e.status) = 'draft') desc, e.date, e.created_at)
      from public.expenses e
      where e.advance_id = p_advance and e.deleted_at is null
    ), '[]'::jsonb)
  );
end;
$$;

-- 4. Save (create or update) a draft -----------------------------------------
create or replace function public.save_advance_draft(p_advance uuid, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_advance public.advances := public.advance_for_expenses(p_advance);
  v_id uuid := nullif(p_payload->>'id', '')::uuid;
  v_amount numeric := coalesce(nullif(p_payload->>'amount', '')::numeric, 0);
  v_existing public.expenses;
  v_other_drafts numeric;
  v_room numeric;
  v_row public.expenses;
begin
  if lower(v_advance.status) in ('pending approval', 'approved', 'rejected', 'cancelled', 'settled') then
    raise exception 'Expenses can only be recorded against an issued advance (this one is %).', v_advance.status;
  end if;
  if v_amount <= 0 then
    raise exception 'Amount must be greater than zero';
  end if;
  if coalesce(trim(p_payload->>'description'), '') = '' then
    raise exception 'Describe what the money was spent on';
  end if;

  if v_id is not null then
    select * into v_existing from public.expenses where id = v_id and advance_id = p_advance and deleted_at is null;
    if v_existing.id is null then
      raise exception 'Draft not found';
    end if;
    if lower(v_existing.status) <> 'draft' then
      raise exception 'Only draft expenses can be changed. % is already %.', v_existing.number, v_existing.status;
    end if;
  end if;

  select coalesce(sum(amount), 0) into v_other_drafts
  from public.expenses
  where advance_id = p_advance and deleted_at is null and lower(status) = 'draft'
    and (v_id is null or id <> v_id);

  v_room := v_advance.amount - v_advance.claimed - v_other_drafts;
  if v_amount > v_room then
    raise exception 'This is % MMK more than the advance has left (% MMK). Record the extra as a normal expense claim.',
      to_char(round(v_amount - v_room), 'FM999,999,999,990'), to_char(round(greatest(v_room, 0)), 'FM999,999,999,990');
  end if;

  if v_id is null then
    insert into public.expenses (category, job_id, supplier_name, employee_id, date, amount, currency, description,
                                 payment_source, advance_id, receipt_file, status, created_by)
    values (
      coalesce(nullif(p_payload->>'category', ''), 'Job'),
      v_advance.job_id,
      nullif(trim(p_payload->>'supplier_name'), ''),
      v_advance.staff_id,
      coalesce(nullif(p_payload->>'date', '')::date, current_date),
      v_amount,
      'MMK',
      trim(p_payload->>'description'),
      'From advance',
      p_advance,
      nullif(p_payload->>'receipt_file', ''),
      'Draft',
      auth.uid()
    )
    returning * into v_row;
  else
    update public.expenses set
      category = coalesce(nullif(p_payload->>'category', ''), category),
      supplier_name = nullif(trim(p_payload->>'supplier_name'), ''),
      date = coalesce(nullif(p_payload->>'date', '')::date, date),
      amount = v_amount,
      description = trim(p_payload->>'description'),
      receipt_file = coalesce(nullif(p_payload->>'receipt_file', ''), receipt_file),
      updated_at = now()
    where id = v_id
    returning * into v_row;
  end if;

  return to_jsonb(v_row);
end;
$$;

-- 5. Delete a draft (hard delete: it never reached the books) ----------------
create or replace function public.delete_advance_draft(p_expense uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.expenses;
begin
  select * into v_row from public.expenses where id = p_expense and deleted_at is null;
  if v_row.id is null or v_row.advance_id is null then
    raise exception 'Draft not found';
  end if;
  perform public.advance_for_expenses(v_row.advance_id);
  if lower(v_row.status) <> 'draft' then
    raise exception '% is already % and cannot be deleted here.', v_row.number, v_row.status;
  end if;
  delete from public.expenses where id = p_expense;
end;
$$;

-- 6. Submit drafts (all, or the given ids) -----------------------------------
create or replace function public.submit_advance_drafts(p_advance uuid, p_expenses uuid[] default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_advance public.advances := public.advance_for_expenses(p_advance);
  v_total numeric;
  v_count integer;
  v_missing integer;
begin
  select count(*), coalesce(sum(amount), 0),
         count(*) filter (where coalesce(receipt_file, '') = '')
    into v_count, v_total, v_missing
  from public.expenses
  where advance_id = p_advance and deleted_at is null and lower(status) = 'draft'
    and (p_expenses is null or id = any(p_expenses));

  if v_count = 0 then
    raise exception 'There are no draft expenses to submit.';
  end if;
  if v_missing > 0 then
    raise exception '% draft expense(s) have no receipt. Attach the receipts before submitting.', v_missing;
  end if;

  perform set_config('tsg.submitting_drafts', 'on', true);
  update public.expenses set status = 'Submitted', updated_at = now()
  where advance_id = p_advance and deleted_at is null and lower(status) = 'draft'
    and (p_expenses is null or id = any(p_expenses));
  perform set_config('tsg.submitting_drafts', 'off', true);

  update public.advances set
    claimed = claimed + v_total,
    status = case when claimed + v_total >= amount then 'Settled' else 'Partially Settled' end,
    settled_at = case when claimed + v_total >= amount then now() else settled_at end,
    updated_at = now()
  where id = p_advance
  returning * into v_advance;

  perform public.notify_admins(
    'Advance expenses submitted',
    format('%s expense(s) totalling %s MMK submitted against advance %s.', v_count, to_char(round(v_total), 'FM999,999,999,990'), v_advance.number),
    v_advance.number
  );

  return public.advance_expenses(p_advance);
end;
$$;

-- 7. Rejecting an advance-funded expense gives the amount back to the advance --
create or replace function public.set_expense_status(p_expense uuid, p_status text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_before public.expenses;
  v_row public.expenses;
begin
  if not public.is_admin() then
    raise exception 'Only administrators can review expenses' using errcode = '42501';
  end if;

  select * into v_before from public.expenses where id = p_expense and deleted_at is null;
  if v_before.id is null then
    raise exception 'Expense not found';
  end if;
  if lower(v_before.status) = 'draft' then
    raise exception 'This expense is still a draft and has not been submitted.';
  end if;

  update public.expenses set
    status = p_status,
    approved_by = case when lower(coalesce(p_status, '')) in ('approved', 'paid') then auth.uid() else approved_by end,
    approved_at = case when lower(coalesce(p_status, '')) in ('approved', 'paid') then now() else approved_at end,
    reimbursed_at = case when lower(coalesce(p_status, '')) = 'paid' then now() else reimbursed_at end
  where id = p_expense
  returning * into v_row;

  if v_row.advance_id is not null
     and lower(coalesce(p_status, '')) = 'rejected'
     and lower(v_before.status) <> 'rejected' then
    update public.advances set
      claimed = greatest(claimed - v_row.amount, 0),
      status = case when greatest(claimed - v_row.amount, 0) >= amount then 'Settled'
                    when greatest(claimed - v_row.amount, 0) > 0 then 'Partially Settled'
                    else 'Issued' end,
      settled_at = case when greatest(claimed - v_row.amount, 0) >= amount then settled_at else null end,
      updated_at = now()
    where id = v_row.advance_id and deleted_at is null;
  end if;

  return to_jsonb(v_row);
end;
$$;

revoke all on function public.advance_for_expenses(uuid) from public, anon, authenticated;
revoke all on function public.advance_expenses(uuid) from public, anon;
revoke all on function public.save_advance_draft(uuid, jsonb) from public, anon;
revoke all on function public.delete_advance_draft(uuid) from public, anon;
revoke all on function public.submit_advance_drafts(uuid, uuid[]) from public, anon;
grant execute on function public.advance_expenses(uuid) to authenticated;
grant execute on function public.save_advance_draft(uuid, jsonb) to authenticated;
grant execute on function public.delete_advance_draft(uuid) to authenticated;
grant execute on function public.submit_advance_drafts(uuid, uuid[]) to authenticated;
