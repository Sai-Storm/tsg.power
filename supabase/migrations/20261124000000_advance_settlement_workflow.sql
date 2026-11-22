-- ============================================================================
-- Staff advance: full settlement workflow, linked to the job order
-- ============================================================================
-- Advance status flow (the Admin role acts as both Manager and Finance):
--
--   Pending Approval --(manager approves)--> Approved --(finance releases
--   money: amount, date, method, reference)--> Issued
--   Issued: staff record expenses as drafts (nothing is sent), then submit the
--           settlement whenever they are ready (not only when the full advance
--           is used)                                   --> Under Review
--   Under Review: manager approves / rejects each expense (rejection needs a
--           reason), then either approves the settlement --> Settlement Approved
--           or returns it to staff for changes        --> Issued
--   Settlement Approved: finance reconciles
--           expenses = advance  -> fully settled
--           expenses < advance  -> staff return the rest (cash receipt)
--           expenses > advance  -> company reimburses the difference (payment)
--                                                       --> Settled (closed)
--
-- Everything is linked to the job order: an advance must name its job order,
-- every expense inherits it, and returns / reimbursements post to the cash
-- book against the same job order.
--
-- Tables
--   advances                   original request + payment release
--   expenses (advance_id set)  individual advance expense records (one row each)
--   advance_submissions        settlement submission batches
--   advance_submission_items   expenses included in each submission (an expense
--                              can only ever be in one submission: unique)
--   advance_approvals          approval / action history
--   advance_returns            money returned by staff
--   advance_reimbursements     additional money paid to staff
-- Receipts stay on expenses.receipt_file (one receipt file per expense).

-- 1. Columns -----------------------------------------------------------------
alter table public.advances
  add column if not exists payment_method text,
  add column if not exists payment_reference text,
  add column if not exists submitted_at timestamptz,
  add column if not exists reviewed_at timestamptz,
  add column if not exists reviewed_by uuid references public.profiles(id),
  add column if not exists review_note text,
  add column if not exists returned_amount numeric(14,2) not null default 0,
  add column if not exists reimbursed_amount numeric(14,2) not null default 0;

alter table public.expenses
  add column if not exists notes text,
  add column if not exists rejection_reason text;

-- 2. New tables --------------------------------------------------------------
create table if not exists public.advance_submissions (
  id uuid primary key default gen_random_uuid(),
  advance_id uuid not null references public.advances(id) on delete cascade,
  job_id uuid references public.jobs(id) on delete set null,
  total numeric(14,2) not null default 0,
  item_count integer not null default 0,
  status text not null default 'Under Review',
  note text,
  submitted_by uuid references public.profiles(id),
  submitted_at timestamptz not null default now(),
  decided_by uuid references public.profiles(id),
  decided_at timestamptz
);

create table if not exists public.advance_submission_items (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null references public.advance_submissions(id) on delete cascade,
  expense_id uuid not null references public.expenses(id) on delete cascade,
  amount numeric(14,2) not null,
  created_at timestamptz not null default now()
);
-- An expense can be in only one open/approved submission. When a settlement is
-- returned to staff, its items are removed so the expense can be resubmitted.
create unique index if not exists advance_submission_items_expense_uq on public.advance_submission_items(expense_id);

create table if not exists public.advance_approvals (
  id uuid primary key default gen_random_uuid(),
  advance_id uuid not null references public.advances(id) on delete cascade,
  submission_id uuid references public.advance_submissions(id) on delete set null,
  expense_id uuid references public.expenses(id) on delete set null,
  action text not null,
  amount numeric(14,2),
  note text,
  actor uuid references public.profiles(id),
  created_at timestamptz not null default now()
);

create table if not exists public.advance_returns (
  id uuid primary key default gen_random_uuid(),
  advance_id uuid not null references public.advances(id) on delete cascade,
  job_id uuid references public.jobs(id) on delete set null,
  amount numeric(14,2) not null check (amount > 0),
  date date not null default current_date,
  method text,
  reference text,
  cash_entry_id uuid references public.cash_entries(id) on delete set null,
  recorded_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);

create table if not exists public.advance_reimbursements (
  id uuid primary key default gen_random_uuid(),
  advance_id uuid not null references public.advances(id) on delete cascade,
  job_id uuid references public.jobs(id) on delete set null,
  amount numeric(14,2) not null check (amount > 0),
  date date not null default current_date,
  method text,
  reference text,
  cash_entry_id uuid references public.cash_entries(id) on delete set null,
  recorded_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);

create index if not exists advance_submissions_advance_idx on public.advance_submissions(advance_id);
create index if not exists advance_approvals_advance_idx on public.advance_approvals(advance_id);
create index if not exists advance_returns_advance_idx on public.advance_returns(advance_id);
create index if not exists advance_reimbursements_advance_idx on public.advance_reimbursements(advance_id);
create index if not exists expenses_advance_idx on public.expenses(advance_id);

-- Read access: admins see everything; staff see rows for their own advances.
-- All writes go through the security-definer functions below.
do $$
declare t text;
begin
  foreach t in array array['advance_submissions','advance_submission_items','advance_approvals','advance_returns','advance_reimbursements'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_admin', t);
    execute format('create policy %I on public.%I for all to authenticated using (public.is_admin()) with check (public.is_admin())', t || '_admin', t);
    execute format('grant select on public.%I to authenticated', t);
  end loop;
end $$;

drop policy if exists advance_submissions_staff_read on public.advance_submissions;
create policy advance_submissions_staff_read on public.advance_submissions for select to authenticated
  using (exists (select 1 from public.advances a where a.id = advance_id and a.staff_id = public.current_staff_id()));
drop policy if exists advance_submission_items_staff_read on public.advance_submission_items;
create policy advance_submission_items_staff_read on public.advance_submission_items for select to authenticated
  using (exists (select 1 from public.advance_submissions s join public.advances a on a.id = s.advance_id
                 where s.id = submission_id and a.staff_id = public.current_staff_id()));
drop policy if exists advance_approvals_staff_read on public.advance_approvals;
create policy advance_approvals_staff_read on public.advance_approvals for select to authenticated
  using (exists (select 1 from public.advances a where a.id = advance_id and a.staff_id = public.current_staff_id()));
drop policy if exists advance_returns_staff_read on public.advance_returns;
create policy advance_returns_staff_read on public.advance_returns for select to authenticated
  using (exists (select 1 from public.advances a where a.id = advance_id and a.staff_id = public.current_staff_id()));
drop policy if exists advance_reimbursements_staff_read on public.advance_reimbursements;
create policy advance_reimbursements_staff_read on public.advance_reimbursements for select to authenticated
  using (exists (select 1 from public.advances a where a.id = advance_id and a.staff_id = public.current_staff_id()));

-- 3. Every new advance must be linked to a job order --------------------------
create or replace function public.require_advance_job()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.job_id is null then
    raise exception 'Choose the job order this advance is for.' using errcode = '23502';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_advances_require_job on public.advances;
create trigger trg_advances_require_job before insert on public.advances
  for each row execute function public.require_advance_job();

-- Advance expenses always carry the advance's job order.
create or replace function public.sync_advance_expense_job()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.advance_id is not null then
    select coalesce(a.job_id, new.job_id) into new.job_id from public.advances a where a.id = new.advance_id;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_expenses_advance_job on public.expenses;
create trigger trg_expenses_advance_job before insert or update of advance_id, job_id on public.expenses
  for each row execute function public.sync_advance_expense_job();

-- Legacy status: partially settled advances are simply still in progress.
update public.advances set status = 'Issued' where lower(status) = 'partially settled';

-- 4. Helpers -----------------------------------------------------------------
-- claimed = expenses that are submitted or approved (not drafts, not rejected).
create or replace function public.refresh_advance_claimed(p_advance uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.advances a set
    claimed = coalesce((
      select sum(e.amount) from public.expenses e
      where e.advance_id = a.id and e.deleted_at is null
        and lower(e.status) not in ('draft', 'rejected')
    ), 0),
    updated_at = now()
  where a.id = p_advance;
$$;

create or replace function public.log_advance_action(p_advance uuid, p_action text, p_note text default null,
  p_amount numeric default null, p_expense uuid default null, p_submission uuid default null)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.advance_approvals (advance_id, submission_id, expense_id, action, amount, note, actor)
  values (p_advance, p_submission, p_expense, p_action, p_amount, nullif(trim(coalesce(p_note, '')), ''), auth.uid());
$$;

create or replace function public.advance_is_open(p_status text)
returns boolean
language sql
immutable
as $$ select lower(coalesce(p_status, '')) in ('issued', 'open', 'partially settled') $$;

-- 5. Manager: approve / reject the request ------------------------------------
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
  select * into v_row from public.advances where id = p_advance and deleted_at is null for update;
  if v_row.id is null then
    raise exception 'Advance not found';
  end if;
  if lower(p_status) in ('approved', 'rejected') and lower(v_row.status) <> 'pending approval' then
    raise exception 'Advance % is % and can no longer be approved or rejected.', v_row.number, v_row.status;
  end if;
  update public.advances set status = p_status, reviewed_at = now(), reviewed_by = auth.uid(), updated_at = now()
  where id = p_advance returning * into v_row;
  perform public.log_advance_action(p_advance, 'Request ' || lower(p_status), null, v_row.amount);
  perform public.notify_staff(v_row.staff_id, 'Advance ' || lower(p_status),
    format('Your advance request %s for %s MMK was %s.', v_row.number, to_char(round(v_row.amount), 'FM999,999,999,990'), lower(p_status)),
    v_row.number);
  return to_jsonb(v_row);
end;
$$;

-- 6. Finance: release the money ------------------------------------------------
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
  select * into v_row from public.advances where id = p_advance and deleted_at is null for update;
  if v_row.id is null then
    raise exception 'Advance not found';
  end if;
  if lower(v_row.status) <> 'approved' then
    raise exception 'Only an approved advance can be released (this one is %).', v_row.status;
  end if;
  update public.advances set
    status = 'Issued',
    issued_on = coalesce(nullif(p_payload->>'date', '')::date, current_date),
    issued_by = auth.uid(),
    amount = coalesce(nullif(p_payload->>'amount', '')::numeric, amount),
    payment_method = nullif(p_payload->>'method', ''),
    payment_reference = nullif(coalesce(p_payload->>'reference', p_payload->>'purpose'), ''),
    updated_at = now()
  where id = p_advance
  returning * into v_row;
  perform public.log_advance_action(p_advance, 'Money released', concat_ws(' · ', v_row.payment_method, v_row.payment_reference), v_row.amount);
  perform public.notify_staff(v_row.staff_id, 'Advance released',
    format('%s MMK for advance %s has been released. Record your expenses in My advances.', to_char(round(v_row.amount), 'FM999,999,999,990'), v_row.number),
    v_row.number);
  return to_jsonb(v_row);
end;
$$;

-- 7. Summary for the advance window --------------------------------------------
create or replace function public.advance_expenses(p_advance uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_advance public.advances := public.advance_for_expenses(p_advance);
  v_drafts numeric; v_submitted numeric; v_approved numeric; v_rejected numeric;
  v_expenses numeric; v_recorded numeric; v_net numeric;
begin
  select coalesce(sum(amount) filter (where lower(status) = 'draft'), 0),
         coalesce(sum(amount) filter (where lower(status) in ('submitted', 'pending approval')), 0),
         coalesce(sum(amount) filter (where lower(status) in ('approved', 'paid')), 0),
         coalesce(sum(amount) filter (where lower(status) = 'rejected'), 0)
    into v_drafts, v_submitted, v_approved, v_rejected
  from public.expenses
  where advance_id = p_advance and deleted_at is null;

  v_expenses := v_submitted + v_approved;          -- submitted for settlement
  v_recorded := v_drafts + v_expenses;             -- everything recorded so far
  v_net := v_advance.amount - v_approved;          -- >0 staff return, <0 company pays

  return jsonb_build_object(
    'advance', jsonb_build_object(
      'id', v_advance.id,
      'number', v_advance.number,
      'purpose', v_advance.purpose,
      'status', v_advance.status,
      'staff_name', (select name from public.staff where id = v_advance.staff_id),
      'date', v_advance.date,
      'due_date', v_advance.due_date,
      'issued_on', v_advance.issued_on,
      'payment_method', v_advance.payment_method,
      'payment_reference', v_advance.payment_reference,
      'submitted_at', v_advance.submitted_at,
      'settled_at', v_advance.settled_at,
      'review_note', v_advance.review_note,
      'job_id', v_advance.job_id,
      'job_number', (select number from public.jobs where id = v_advance.job_id),
      'job_title', (select coalesce(title, '') from public.jobs where id = v_advance.job_id),
      'amount', v_advance.amount,
      'claimed', v_expenses,
      'drafts', v_drafts,
      'submitted', v_submitted,
      'approved', v_approved,
      'rejected', v_rejected,
      'recorded', v_recorded,
      'remaining', greatest(v_advance.amount - v_recorded, 0),
      'over', greatest(v_recorded - v_advance.amount, 0),
      'net', v_net,
      'returned_amount', v_advance.returned_amount,
      'reimbursed_amount', v_advance.reimbursed_amount,
      'can_record', public.advance_is_open(v_advance.status),
      'can_review', lower(v_advance.status) = 'under review',
      'can_reconcile', lower(v_advance.status) = 'settlement approved'
    ),
    'entries', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', e.id,
        'number', e.number,
        'date', e.date,
        'category', e.category,
        'supplier_name', e.supplier_name,
        'description', e.description,
        'notes', e.notes,
        'amount', e.amount,
        'status', e.status,
        'rejection_reason', e.rejection_reason,
        'receipt_file', e.receipt_file,
        'job_number', j.number,
        'created_at', e.created_at
      ) order by (lower(e.status) = 'draft') desc, e.date, e.created_at)
      from public.expenses e
      left join public.jobs j on j.id = e.job_id
      where e.advance_id = p_advance and e.deleted_at is null
    ), '[]'::jsonb),
    'history', coalesce((
      select jsonb_agg(jsonb_build_object(
        'action', h.action, 'amount', h.amount, 'note', h.note, 'at', h.created_at,
        'by', coalesce((select s.name from public.staff s where s.profile_id = h.actor), (select p.name from public.profiles p where p.id = h.actor))
      ) order by h.created_at desc)
      from public.advance_approvals h where h.advance_id = p_advance
    ), '[]'::jsonb)
  );
end;
$$;

-- 8. Staff: save a draft (never sent to anyone) -------------------------------
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
  v_row public.expenses;
begin
  if not public.advance_is_open(v_advance.status) then
    raise exception 'Expenses can only be recorded while the advance is in progress (this one is %).', v_advance.status;
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

  if v_id is null then
    insert into public.expenses (category, job_id, supplier_name, employee_id, date, amount, currency, description, notes,
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
      nullif(trim(coalesce(p_payload->>'notes', '')), ''),
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
      notes = nullif(trim(coalesce(p_payload->>'notes', '')), ''),
      receipt_file = coalesce(nullif(p_payload->>'receipt_file', ''), receipt_file),
      updated_at = now()
    where id = v_id
    returning * into v_row;
  end if;

  return to_jsonb(v_row);
end;
$$;

-- 9. Staff: submit the settlement (one transaction, no double submission) -----
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
    raise exception 'This advance is % and cannot be submitted again.', v_advance.status;
  end if;

  perform 1 from public.expenses
  where advance_id = p_advance and deleted_at is null and lower(status) = 'draft'
  for update;

  select count(*), coalesce(sum(amount), 0), count(*) filter (where coalesce(receipt_file, '') = '')
    into v_count, v_total, v_missing
  from public.expenses
  where advance_id = p_advance and deleted_at is null and lower(status) = 'draft';

  if v_count = 0 then
    raise exception 'There are no draft expenses to submit.';
  end if;
  if v_missing > 0 then
    raise exception '% expense(s) have no receipt. Attach the receipts before submitting.', v_missing;
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

  perform public.log_advance_action(p_advance, 'Settlement submitted', p_note, v_total, null, v_submission);
  perform public.notify_admins(
    'Advance settlement submitted',
    format('%s submitted %s expense(s) totalling %s MMK for advance %s (job %s). Advance %s MMK, %s.',
      (select name from public.staff where id = v_advance.staff_id), v_count, to_char(round(v_total), 'FM999,999,999,990'),
      v_advance.number, coalesce((select number from public.jobs where id = v_advance.job_id), '—'),
      to_char(round(v_advance.amount), 'FM999,999,999,990'),
      case when v_all = v_advance.amount then 'fully used'
           when v_all < v_advance.amount then to_char(round(v_advance.amount - v_all), 'FM999,999,999,990') || ' MMK to be returned'
           else to_char(round(v_all - v_advance.amount), 'FM999,999,999,990') || ' MMK to be reimbursed' end),
    v_advance.number
  );

  return public.advance_expenses(p_advance);
end;
$$;

-- Old entry point now submits the whole settlement.
create or replace function public.submit_advance_drafts(p_advance uuid, p_expenses uuid[] default null)
returns jsonb
language sql
security definer
set search_path = public
as $$ select public.submit_advance_settlement(p_advance, null) $$;

-- 10. Manager: approve / reject one expense ------------------------------------
create or replace function public.review_advance_expense(p_expense uuid, p_decision text, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.expenses;
  v_advance public.advances;
  v_status text := initcap(lower(coalesce(p_decision, '')));
begin
  if not public.is_admin() then
    raise exception 'Only administrators can review expenses' using errcode = '42501';
  end if;
  if v_status not in ('Approved', 'Rejected') then
    raise exception 'Decision must be Approved or Rejected';
  end if;
  if v_status = 'Rejected' and coalesce(trim(p_reason), '') = '' then
    raise exception 'Give a reason for rejecting this expense.';
  end if;
  select * into v_row from public.expenses where id = p_expense and deleted_at is null;
  if v_row.id is null or v_row.advance_id is null then
    raise exception 'Advance expense not found';
  end if;
  select * into v_advance from public.advances where id = v_row.advance_id for update;
  if lower(v_advance.status) <> 'under review' then
    raise exception 'Expenses can only be reviewed while the settlement is under review (advance is %).', v_advance.status;
  end if;
  if lower(v_row.status) = 'draft' then
    raise exception 'This expense is still a draft and has not been submitted.';
  end if;

  update public.expenses set
    status = v_status,
    rejection_reason = case when v_status = 'Rejected' then trim(p_reason) else null end,
    approved_by = case when v_status = 'Approved' then auth.uid() else null end,
    approved_at = case when v_status = 'Approved' then now() else null end,
    updated_at = now()
  where id = p_expense
  returning * into v_row;

  perform public.refresh_advance_claimed(v_row.advance_id);
  perform public.log_advance_action(v_row.advance_id, 'Expense ' || lower(v_status) || ': ' || coalesce(v_row.description, v_row.number), p_reason, v_row.amount, v_row.id);
  return public.advance_expenses(v_row.advance_id);
end;
$$;

-- 11. Manager: approve the settlement, or return it to staff -------------------
create or replace function public.decide_advance_settlement(p_advance uuid, p_decision text, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_advance public.advances;
  v_approved numeric;
  v_decision text := lower(coalesce(p_decision, ''));
begin
  if not public.is_admin() then
    raise exception 'Only administrators can approve settlements' using errcode = '42501';
  end if;
  select * into v_advance from public.advances where id = p_advance and deleted_at is null for update;
  if v_advance.id is null then
    raise exception 'Advance not found';
  end if;
  if lower(v_advance.status) <> 'under review' then
    raise exception 'This settlement is % and is not waiting for review.', v_advance.status;
  end if;

  if v_decision = 'approve' then
    -- Anything not individually rejected is approved with the settlement.
    update public.expenses set status = 'Approved', approved_by = auth.uid(), approved_at = now(), updated_at = now()
    where advance_id = p_advance and deleted_at is null and lower(status) in ('submitted', 'pending approval');
    update public.advance_submissions set status = 'Approved', decided_by = auth.uid(), decided_at = now()
    where advance_id = p_advance and status = 'Under Review';
    update public.advances set status = 'Settlement Approved', reviewed_at = now(), reviewed_by = auth.uid(),
      review_note = nullif(trim(coalesce(p_note, '')), ''), updated_at = now()
    where id = p_advance;
    perform public.refresh_advance_claimed(p_advance);
    select coalesce(sum(amount), 0) into v_approved from public.expenses
    where advance_id = p_advance and deleted_at is null and lower(status) in ('approved', 'paid');
    perform public.log_advance_action(p_advance, 'Settlement approved', p_note, v_approved);
    perform public.notify_staff(v_advance.staff_id, 'Advance settlement approved',
      format('Settlement for advance %s approved: %s MMK of expenses. %s', v_advance.number, to_char(round(v_approved), 'FM999,999,999,990'),
        case when v_approved < v_advance.amount then 'Please return ' || to_char(round(v_advance.amount - v_approved), 'FM999,999,999,990') || ' MMK to finance.'
             when v_approved > v_advance.amount then 'Finance will reimburse ' || to_char(round(v_approved - v_advance.amount), 'FM999,999,999,990') || ' MMK.'
             else 'The advance is fully used.' end),
      v_advance.number);
  elsif v_decision = 'return' then
    if coalesce(trim(p_note), '') = '' then
      raise exception 'Tell the staff member what to change before returning the settlement.';
    end if;
    -- Undecided expenses go back to draft so staff can correct them; approved and
    -- rejected decisions are kept.
    delete from public.advance_submission_items i
    using public.expenses e
    where i.expense_id = e.id and e.advance_id = p_advance and lower(e.status) in ('submitted', 'pending approval', 'rejected');
    update public.expenses set status = 'Draft', updated_at = now()
    where advance_id = p_advance and deleted_at is null and lower(status) in ('submitted', 'pending approval');
    update public.advance_submissions set status = 'Returned', decided_by = auth.uid(), decided_at = now(), note = coalesce(note, p_note)
    where advance_id = p_advance and status = 'Under Review';
    update public.advances set status = 'Issued', review_note = trim(p_note), updated_at = now() where id = p_advance;
    perform public.refresh_advance_claimed(p_advance);
    perform public.log_advance_action(p_advance, 'Settlement returned to staff', p_note);
    perform public.notify_staff(v_advance.staff_id, 'Advance settlement returned',
      format('Advance %s was returned for changes: %s', v_advance.number, trim(p_note)), v_advance.number);
  else
    raise exception 'Decision must be approve or return';
  end if;

  return public.advance_expenses(p_advance);
end;
$$;

-- 12. Finance: reconcile (return / reimburse) and close ------------------------
create or replace function public.reconcile_advance(p_advance uuid, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_advance public.advances;
  v_approved numeric;
  v_net numeric;
  v_date date := coalesce(nullif(p_payload->>'date', '')::date, current_date);
  v_method text := coalesce(nullif(p_payload->>'method', ''), 'Cash');
  v_reference text := nullif(trim(coalesce(p_payload->>'reference', '')), '');
  v_staff text;
  v_cash uuid;
begin
  if not public.is_admin() then
    raise exception 'Only administrators can settle advances' using errcode = '42501';
  end if;
  select * into v_advance from public.advances where id = p_advance and deleted_at is null for update;
  if v_advance.id is null then
    raise exception 'Advance not found';
  end if;
  if lower(v_advance.status) <> 'settlement approved' then
    raise exception 'The settlement must be approved before finance can close it (advance is %).', v_advance.status;
  end if;

  select coalesce(sum(amount), 0) into v_approved from public.expenses
  where advance_id = p_advance and deleted_at is null and lower(status) in ('approved', 'paid');
  v_net := v_advance.amount - v_approved;
  v_staff := (select name from public.staff where id = v_advance.staff_id);

  if v_net > 0 then
    insert into public.cash_entries (type, date, account, reference_type, source_id, job_id, counterparty, amount, method, description, status, posted_at, created_by)
    values ('Receipt', v_date, 'Cash', 'Advance return', v_advance.id::text, v_advance.job_id, v_staff, v_net, v_method,
            concat_ws(' · ', 'Unused advance returned · ' || coalesce(v_advance.number, ''), v_reference), 'Posted', now(), auth.uid())
    returning id into v_cash;
    insert into public.advance_returns (advance_id, job_id, amount, date, method, reference, cash_entry_id, recorded_by)
    values (p_advance, v_advance.job_id, v_net, v_date, v_method, v_reference, v_cash, auth.uid());
    perform public.log_advance_action(p_advance, 'Returned cash recorded', concat_ws(' · ', v_method, v_reference), v_net);
  elsif v_net < 0 then
    insert into public.cash_entries (type, date, account, reference_type, source_id, job_id, counterparty, amount, method, description, status, posted_at, created_by)
    values ('Payment', v_date, 'Cash', 'Advance reimbursement', v_advance.id::text, v_advance.job_id, v_staff, -v_net, v_method,
            concat_ws(' · ', 'Extra expenses reimbursed · ' || coalesce(v_advance.number, ''), v_reference), 'Posted', now(), auth.uid())
    returning id into v_cash;
    insert into public.advance_reimbursements (advance_id, job_id, amount, date, method, reference, cash_entry_id, recorded_by)
    values (p_advance, v_advance.job_id, -v_net, v_date, v_method, v_reference, v_cash, auth.uid());
    perform public.log_advance_action(p_advance, 'Reimbursement paid', concat_ws(' · ', v_method, v_reference), -v_net);
  end if;

  update public.advances set
    status = 'Settled',
    settled_at = now(),
    returned_amount = returned_amount + greatest(v_net, 0),
    reimbursed_amount = reimbursed_amount + greatest(-v_net, 0),
    updated_at = now()
  where id = p_advance;
  perform public.refresh_advance_claimed(p_advance);
  perform public.log_advance_action(p_advance, 'Advance closed', null, v_approved);
  perform public.notify_staff(v_advance.staff_id, 'Advance closed',
    format('Advance %s is closed. %s', v_advance.number,
      case when v_net > 0 then to_char(round(v_net), 'FM999,999,999,990') || ' MMK returned.'
           when v_net < 0 then to_char(round(-v_net), 'FM999,999,999,990') || ' MMK reimbursed to you.'
           else 'Fully settled.' end),
    v_advance.number);
  return public.advance_expenses(p_advance);
end;
$$;

-- Old "settle" entry point now runs the reconciliation.
create or replace function public.settle_advance(p_advance uuid, p_amount numeric)
returns jsonb
language sql
security definer
set search_path = public
as $$ select public.reconcile_advance(p_advance, '{}'::jsonb) $$;

-- 13. Advance expenses are reviewed in the advance, not in the claims list -----
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
  if v_before.advance_id is not null then
    raise exception 'This expense belongs to a staff advance. Review it from Staff advances → Review settlement.';
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
  return to_jsonb(v_row);
end;
$$;

-- 14. Lists: advance expenses are labelled and only shown to admins (never drafts)
create or replace view public.v_expenses
with (security_invoker = true) as
select
  e.id,
  e.number as reference,
  e.number as voucher,
  case when e.advance_id is not null then 'Advance expense' else 'Expense claim' end::text as type,
  e.category,
  coalesce(st.name, 'Employee') as employee_source,
  j.number as job_order,
  e.date,
  public.money(e.amount) as amount,
  e.status,
  e.id as expense_id,
  e.amount as amount_value,
  e.employee_id,
  e.job_id,
  e.office_type,
  e.supplier_id,
  e.supplier_name,
  e.currency,
  e.description,
  e.payment_source,
  e.advance_id,
  e.receipt_file,
  e.exception_reason,
  e.approved_by,
  e.approved_at,
  e.reimbursed_at,
  e.created_by,
  e.created_at,
  e.updated_at
from public.expenses e
left join public.staff st on st.id = e.employee_id
left join public.jobs j on j.id = e.job_id
where e.deleted_at is null
  -- Advance expenses live in My advances for staff; admins see them (not drafts).
  and (e.advance_id is null or (public.is_admin() and lower(e.status) <> 'draft'))
union all
select
  a.id,
  a.number,
  a.number,
  'Staff advance'::text,
  'Advance'::text,
  st.name,
  j.number,
  a.date,
  public.money(a.amount),
  a.status,
  a.id,
  a.amount,
  a.staff_id,
  a.job_id,
  null,
  null,
  null,
  null,
  a.purpose,
  null,
  null,
  null,
  null,
  null,
  null,
  a.settled_at,
  a.created_by,
  a.created_at,
  a.updated_at
from public.advances a
left join public.staff st on st.id = a.staff_id
left join public.jobs j on j.id = a.job_id
where a.deleted_at is null and public.is_admin()
union all
select
  ce.id,
  ce.number,
  ce.number,
  ('Cash ' || ce.type)::text,
  'Cash'::text,
  coalesce(ce.counterparty, ce.account, 'Company cash'),
  j.number,
  ce.date,
  public.money(ce.amount),
  ce.status,
  ce.id,
  ce.amount,
  null,
  ce.job_id,
  null,
  null,
  null,
  null,
  ce.description,
  null,
  null,
  ce.attachment,
  null,
  null,
  null,
  null,
  ce.created_by,
  ce.created_at,
  ce.updated_at
from public.cash_entries ce
left join public.jobs j on j.id = ce.job_id
where ce.deleted_at is null and public.is_admin();

-- Advance list: balance is what is still with the staff member (0 once closed).
create or replace view public.v_advances
with (security_invoker = true) as
select a.id,
  a.number as advance,
  a.date as issued,
  a.purpose,
  public.money(a.amount) as amount,
  public.money(a.claimed) as claimed,
  public.money(case when lower(a.status) in ('settled', 'rejected', 'cancelled', 'pending approval', 'approved') then 0
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
  j.number as job_order
from public.advances a
left join public.staff st on st.id = a.staff_id
left join public.jobs j on j.id = a.job_id
where a.deleted_at is null;

-- 15. Grants -----------------------------------------------------------------
revoke all on function public.refresh_advance_claimed(uuid) from public, anon, authenticated;
revoke all on function public.log_advance_action(uuid, text, text, numeric, uuid, uuid) from public, anon, authenticated;
revoke all on function public.submit_advance_settlement(uuid, text) from public, anon;
revoke all on function public.review_advance_expense(uuid, text, text) from public, anon;
revoke all on function public.decide_advance_settlement(uuid, text, text) from public, anon;
revoke all on function public.reconcile_advance(uuid, jsonb) from public, anon;
grant execute on function public.submit_advance_settlement(uuid, text) to authenticated;
grant execute on function public.review_advance_expense(uuid, text, text) to authenticated;
grant execute on function public.decide_advance_settlement(uuid, text, text) to authenticated;
grant execute on function public.reconcile_advance(uuid, jsonb) to authenticated;
grant execute on function public.advance_is_open(text) to authenticated;
