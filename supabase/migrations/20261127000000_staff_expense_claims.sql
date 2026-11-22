-- ============================================================================
-- Expense claims inside My advances
-- ============================================================================
-- Staff who paid for company expenses with their own money (no advance) open
-- an expense claim from My advances. A claim is an advance of kind 'Claim':
--
--   * numbered CLM-YYYY-NNNN, amount is always 0 (no money is released first)
--   * opens straight in progress (status Issued): there is nothing to approve
--     or release before the staff member has spent anything
--   * the job order is optional (office expenses have none); when set, every
--     expense in the claim is booked against it
--   * then the normal settlement flow: drafts -> Submit to manager -> manager
--     approves / rejects each expense -> Settlement Approved -> finance pays
--     the approved total (advance 0 - approved = company pays) -> Settled
--   * the owner can cancel a claim while nothing has been submitted
--
-- Rules for every advance expense (advances and claims):
--   * the expense date cannot be in the future
--   * a receipt is required, or a written reason why there is none
-- Extra rule for claims:
--   * expenses older than 90 days cannot be claimed

-- 1. Kind column ---------------------------------------------------------------
alter table public.advances
  add column if not exists kind text not null default 'Advance';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'advances_kind_check') then
    alter table public.advances add constraint advances_kind_check check (kind in ('Advance', 'Claim'));
  end if;
end $$;

-- 2. New rows: claims get their own numbers and always start open at 0 ----------
create or replace function public.stamp_advance_owner()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.created_by is null then
    new.created_by := auth.uid();
  end if;
  new.kind := coalesce(new.kind, 'Advance');

  if new.kind = 'Claim' then
    -- Nothing is paid out in advance: the claim is open for expenses at once.
    new.staff_id := coalesce(new.staff_id, public.current_staff_id());
    new.amount := 0;
    new.claimed := 0;
    new.status := 'Issued';
    new.issued_on := coalesce(new.date, current_date);
    new.issued_by := null;
    new.due_date := null;
    new.payment_method := null;
    new.payment_reference := null;
  elsif not public.is_admin() then
    new.staff_id := coalesce(public.current_staff_id(), new.staff_id);
    new.status := 'Pending Approval';
    new.claimed := 0;
    new.issued_on := null;
    new.issued_by := null;
    new.settled_at := null;
    new.payment_method := null;
    new.payment_reference := null;
    new.submitted_at := null;
    new.reviewed_at := null;
    new.reviewed_by := null;
    new.review_note := null;
    new.returned_amount := 0;
    new.reimbursed_amount := 0;
  end if;

  if new.staff_id is null then
    raise exception 'Your login is not linked to a staff record. Contact an administrator.'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

-- Claim numbers: CLM-YYYY-NNNN. Triggers fire in name order, so this one
-- ("..._claim_number") runs before the ADV- numbering ("..._number").
create or replace function public.set_claim_number()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.kind = 'Claim' and coalesce(new.number, '') = '' then
    new.number := public.next_document_number('expense_claim_' || to_char(now(), 'YYYY'), 'CLM-' || to_char(now(), 'YYYY') || '-', 4);
  end if;
  return new;
end;
$$;

drop trigger if exists trg_advances_claim_number on public.advances;
create trigger trg_advances_claim_number before insert on public.advances
  for each row execute function public.set_claim_number();

-- A claim never turns into an advance (or back), and never holds released money.
create or replace function public.guard_advance_kind()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.kind := old.kind;
  if new.kind = 'Claim' then
    new.amount := 0;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_advances_kind on public.advances;
create trigger trg_advances_kind before update on public.advances
  for each row execute function public.guard_advance_kind();

-- Advances must name a job order; claims may be office expenses with none.
create or replace function public.require_advance_job()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.job_id is null and coalesce(new.kind, 'Advance') <> 'Claim' then
    raise exception 'Choose the job order this advance is for.' using errcode = '23502';
  end if;
  return new;
end;
$$;

-- 3. Staff: open a claim -------------------------------------------------------
create or replace function public.open_expense_claim(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_staff uuid := public.current_staff_id();
  v_job uuid := nullif(p_payload->>'job_id', '')::uuid;
  v_purpose text := nullif(trim(coalesce(p_payload->>'purpose', '')), '');
  v_row public.advances;
begin
  if v_staff is null then
    raise exception 'Your login is not linked to a staff record. Contact an administrator.' using errcode = '42501';
  end if;
  if v_purpose is null then
    raise exception 'Say what this claim is for (e.g. "Site visit to Mandalay").';
  end if;
  if v_job is not null and not exists (select 1 from public.jobs where id = v_job and deleted_at is null) then
    raise exception 'Job order not found';
  end if;

  insert into public.advances (kind, staff_id, job_id, purpose, date, amount)
  values ('Claim', v_staff, v_job, v_purpose, current_date, 0)
  returning * into v_row;

  perform public.log_advance_action(v_row.id, 'Claim opened', v_purpose);
  return to_jsonb(v_row);
end;
$$;

-- 4. Staff: cancel a claim that has nothing submitted -------------------------
create or replace function public.cancel_expense_claim(p_advance uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.advances;
begin
  select * into v_row from public.advances where id = p_advance and deleted_at is null for update;
  if v_row.id is null then
    raise exception 'Claim not found';
  end if;
  if not (v_row.staff_id = public.current_staff_id() or public.is_admin()) then
    raise exception 'Not authorized for this claim' using errcode = '42501';
  end if;
  if v_row.kind <> 'Claim' then
    raise exception 'Only expense claims can be cancelled here. Advances are closed by finance.';
  end if;
  if not public.advance_is_open(v_row.status) then
    raise exception 'This claim is % and can no longer be cancelled.', v_row.status;
  end if;
  if exists (select 1 from public.expenses where advance_id = p_advance and deleted_at is null
             and lower(status) in ('submitted', 'pending approval', 'approved', 'paid')) then
    raise exception 'Expenses in this claim have already been sent to the manager, so it cannot be cancelled.';
  end if;

  update public.expenses set deleted_at = now(), deleted_by = auth.uid(), updated_at = now()
  where advance_id = p_advance and deleted_at is null;
  update public.advances set status = 'Cancelled', updated_at = now() where id = p_advance;
  perform public.refresh_advance_claimed(p_advance);
  perform public.log_advance_action(p_advance, 'Claim cancelled');
  return public.advance_expenses(p_advance);
end;
$$;

-- 5. Drafts: receipt exception reason, date rules, claim defaults ---------------
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
  v_date date := coalesce(nullif(p_payload->>'date', '')::date, current_date);
  v_reason text := nullif(trim(coalesce(p_payload->>'exception_reason', '')), '');
  v_new_files text[] := public.json_text_list(p_payload->'receipt_file') || public.json_text_list(p_payload->'receipt_files');
  v_remove text[] := public.json_text_list(p_payload->'remove_receipts');
  v_is_claim boolean := v_advance.kind = 'Claim';
  v_existing public.expenses;
  v_row public.expenses;
begin
  if not public.advance_is_open(v_advance.status) then
    raise exception 'Expenses can only be recorded while the % is in progress (this one is %).',
      case when v_is_claim then 'claim' else 'advance' end, v_advance.status;
  end if;
  if v_amount <= 0 then
    raise exception 'Amount must be greater than zero';
  end if;
  if coalesce(trim(p_payload->>'description'), '') = '' then
    raise exception 'Describe what the money was spent on';
  end if;
  if v_date > current_date then
    raise exception 'The expense date cannot be in the future.';
  end if;
  if v_is_claim and v_date < current_date - 90 then
    raise exception 'Expenses older than 90 days cannot be claimed. Contact finance.';
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

  if v_id is null then
    insert into public.expenses (category, job_id, supplier_name, employee_id, date, amount, currency, description, notes,
                                 payment_source, advance_id, receipt_files, exception_reason, status, created_by)
    values (
      coalesce(nullif(p_payload->>'category', ''), case when v_advance.job_id is null then 'Office' else 'Job' end),
      v_advance.job_id,
      nullif(trim(p_payload->>'supplier_name'), ''),
      v_advance.staff_id,
      v_date,
      v_amount,
      'MMK',
      trim(p_payload->>'description'),
      nullif(trim(coalesce(p_payload->>'notes', '')), ''),
      case when v_is_claim then 'Employee' else 'From advance' end,
      p_advance,
      v_new_files,
      v_reason,
      'Draft',
      auth.uid()
    )
    returning * into v_row;
  else
    update public.expenses set
      category = coalesce(nullif(p_payload->>'category', ''), category),
      supplier_name = nullif(trim(p_payload->>'supplier_name'), ''),
      date = v_date,
      amount = v_amount,
      description = trim(p_payload->>'description'),
      notes = nullif(trim(coalesce(p_payload->>'notes', '')), ''),
      exception_reason = v_reason,
      receipt_file = null,
      receipt_files = array(select f from unnest(receipt_files || v_new_files) f where not (f = any(v_remove))),
      updated_at = now()
    where id = v_id
    returning * into v_row;
  end if;

  return to_jsonb(v_row);
end;
$$;

-- 6. Submit: receipt or written reason; wording for claims ----------------------
create or replace function public.submit_advance_settlement(p_advance uuid, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_advance public.advances;
  v_submission uuid;
  v_total numeric;
  v_count integer;
  v_missing integer;
  v_all numeric;
  v_outcome text;
begin
  -- Lock the advance so two clicks / two tabs cannot submit at the same time.
  select * into v_advance from public.advances where id = p_advance and deleted_at is null for update;
  if v_advance.id is null then
    raise exception 'Advance not found';
  end if;
  if not (v_advance.staff_id = public.current_staff_id() or public.is_admin()) then
    raise exception 'Not authorized for this advance' using errcode = '42501';
  end if;
  if not public.advance_is_open(v_advance.status) then
    raise exception 'This % is % and cannot be submitted again.',
      case when v_advance.kind = 'Claim' then 'claim' else 'advance' end, v_advance.status;
  end if;

  perform 1 from public.expenses
  where advance_id = p_advance and deleted_at is null and lower(status) = 'draft'
  for update;

  select count(*), coalesce(sum(amount), 0),
         count(*) filter (where coalesce(receipt_file, '') = '' and coalesce(trim(exception_reason), '') = '')
    into v_count, v_total, v_missing
  from public.expenses
  where advance_id = p_advance and deleted_at is null and lower(status) = 'draft';

  if v_count = 0 then
    raise exception 'There are no draft expenses to submit.';
  end if;
  if v_missing > 0 then
    raise exception '% expense(s) have no receipt. Attach the receipt, or explain why there is none.', v_missing;
  end if;

  insert into public.advance_submissions (advance_id, job_id, total, item_count, note, submitted_by)
  values (p_advance, v_advance.job_id, v_total, v_count, nullif(trim(coalesce(p_note, '')), ''), auth.uid())
  returning id into v_submission;

  insert into public.advance_submission_items (submission_id, expense_id, amount)
  select v_submission, id, amount from public.expenses
  where advance_id = p_advance and deleted_at is null and lower(status) = 'draft';

  perform set_config('tsg.submitting_drafts', 'on', true);
  update public.expenses set status = 'Submitted', rejection_reason = null, updated_at = now()
  where advance_id = p_advance and deleted_at is null and lower(status) = 'draft';
  perform set_config('tsg.submitting_drafts', 'off', true);

  update public.advances set status = 'Under Review', submitted_at = now(), review_note = null, updated_at = now()
  where id = p_advance;
  perform public.refresh_advance_claimed(p_advance);

  select coalesce(sum(amount), 0) into v_all from public.expenses
  where advance_id = p_advance and deleted_at is null and lower(status) not in ('draft', 'rejected');

  if v_advance.kind = 'Claim' then
    v_outcome := format('Expense claim of %s MMK to be reimbursed.', to_char(round(v_all), 'FM999,999,999,990'));
  else
    v_outcome := format('Advance %s MMK, %s.', to_char(round(v_advance.amount), 'FM999,999,999,990'),
      case when v_all = v_advance.amount then 'fully used'
           when v_all < v_advance.amount then to_char(round(v_advance.amount - v_all), 'FM999,999,999,990') || ' MMK to be returned'
           else to_char(round(v_all - v_advance.amount), 'FM999,999,999,990') || ' MMK to be reimbursed' end);
  end if;

  perform public.log_advance_action(p_advance, 'Settlement submitted', p_note, v_total, null, v_submission);
  perform public.notify_admins(
    case when v_advance.kind = 'Claim' then 'Expense claim submitted' else 'Advance settlement submitted' end,
    format('%s submitted %s expense(s) totalling %s MMK for %s (job %s). %s',
      (select name from public.staff where id = v_advance.staff_id), v_count, to_char(round(v_total), 'FM999,999,999,990'),
      v_advance.number, coalesce((select number from public.jobs where id = v_advance.job_id), '—'), v_outcome),
    v_advance.number
  );

  return public.advance_expenses(p_advance);
end;
$$;

-- 7. Small wording / data patches to existing functions ------------------------
-- These functions were adjusted in place by earlier migrations (Finance role),
-- so they are patched rather than rewritten. Each patch must apply.
do $$
declare
  v_def text;
  v_new text;
begin
  -- Advance window: tell the screen whether this is a claim, and show the
  -- receipt exception reason on each expense.
  v_def := pg_get_functiondef('public.advance_expenses(uuid)'::regprocedure);
  v_new := replace(v_def, $r$'id', v_advance.id,$r$, $r$'id', v_advance.id, 'kind', v_advance.kind,$r$);
  v_new := replace(v_new, $r$'rejection_reason', e.rejection_reason,$r$, $r$'rejection_reason', e.rejection_reason, 'exception_reason', e.exception_reason, 'payment_source', e.payment_source,$r$);
  if v_new = v_def or v_new not like '%''exception_reason''%' then
    raise exception 'advance_expenses patch did not apply';
  end if;
  execute v_new;

  -- Settlement approved with nothing approved on a claim: nothing to pay.
  v_def := pg_get_functiondef('public.decide_advance_settlement(uuid, text, text)'::regprocedure);
  v_new := replace(v_def, $r$else 'The advance is fully used.' end),$r$,
    $r$when v_advance.kind = 'Claim' then 'Nothing was approved, so there is nothing to pay.' else 'The advance is fully used.' end),$r$);
  if v_new = v_def then
    raise exception 'decide_advance_settlement patch did not apply';
  end if;
  execute v_new;

  -- Cash book wording for a paid claim.
  v_def := pg_get_functiondef('public.reconcile_advance(uuid, jsonb)'::regprocedure);
  v_new := replace(v_def, $r$'Extra expenses reimbursed · ' || coalesce(v_advance.number, '')$r$,
    $r$case when v_advance.kind = 'Claim' then 'Expense claim reimbursed · ' else 'Extra expenses reimbursed · ' end || coalesce(v_advance.number, '')$r$);
  if v_new = v_def then
    raise exception 'reconcile_advance patch did not apply';
  end if;
  execute v_new;
end $$;

-- 8. Lists: type column; a claim shows its claimed total as its amount ---------
create or replace view public.v_advances
with (security_invoker = true) as
select a.id,
  a.number as advance,
  a.date as issued,
  a.purpose,
  public.money(case when a.kind = 'Claim' then a.claimed else a.amount end) as amount,
  public.money(a.claimed) as claimed,
  public.money(case when a.kind = 'Claim' or lower(a.status) in ('settled', 'rejected', 'cancelled', 'pending approval', 'approved') then 0
                    else greatest(a.amount - a.claimed, 0) end) as balance,
  a.status,
  a.staff_id,
  a.job_id,
  a.due_date,
  a.issued_on,
  a.settled_at,
  a.created_by,
  a.created_at,
  a.updated_at,
  st.name as staff_name,
  coalesce(j.number, case when a.kind = 'Claim' then 'Office' end) as job_order,
  a.kind as type
from public.advances a
left join public.staff st on st.id = a.staff_id
left join public.jobs j on j.id = a.job_id
where a.deleted_at is null;

-- 9. Grants and version ---------------------------------------------------------
revoke all on function public.open_expense_claim(jsonb) from public, anon;
revoke all on function public.cancel_expense_claim(uuid) from public, anon;
grant execute on function public.open_expense_claim(jsonb) to authenticated;
grant execute on function public.cancel_expense_claim(uuid) to authenticated;

create or replace function public.schema_version()
returns text language sql immutable as $$ select '20261127000000'::text $$;
grant execute on function public.schema_version() to anon, authenticated;
