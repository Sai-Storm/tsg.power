-- ============================================================================
-- Job profitability, advance overview & reminders, multiple receipts,
-- and hardening of staff advance requests
-- ============================================================================

-- 1. Staff advance requests: staff choose only job, dates, amount and purpose --
-- Everything finance controls is reset for non-admins, so a request can never
-- arrive already released, claimed or reconciled.
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

  if not public.is_admin() then
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

    if new.staff_id is null then
      raise exception 'Your login is not linked to a staff record. Contact an administrator.'
        using errcode = '42501';
    end if;
  end if;

  return new;
end;
$$;

-- 2. More than one receipt per expense -----------------------------------------
-- receipt_files holds every receipt; receipt_file stays the first one so all
-- existing checks ("has a receipt") and screens keep working.
alter table public.expenses add column if not exists receipt_files text[] not null default '{}';

create or replace function public.sync_expense_receipts()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.receipt_files := array(select distinct on (f) f from unnest(coalesce(new.receipt_files, '{}')) f where coalesce(f, '') <> '');
  if coalesce(new.receipt_file, '') <> '' and not (new.receipt_file = any(new.receipt_files)) then
    new.receipt_files := array_prepend(new.receipt_file, new.receipt_files);
  end if;
  new.receipt_file := case when cardinality(new.receipt_files) > 0 then new.receipt_files[1] else null end;
  return new;
end;
$$;

drop trigger if exists trg_expenses_receipts on public.expenses;
create trigger trg_expenses_receipts before insert or update of receipt_file, receipt_files on public.expenses
  for each row execute function public.sync_expense_receipts();

update public.expenses set receipt_files = array[receipt_file] where coalesce(receipt_file, '') <> '' and cardinality(receipt_files) = 0;

-- Accepts a JSON string or array of file URLs.
create or replace function public.json_text_list(p_value jsonb)
returns text[]
language sql
immutable
as $$
  select case
    when p_value is null or p_value = 'null'::jsonb then '{}'::text[]
    when jsonb_typeof(p_value) = 'array' then array(select x from jsonb_array_elements_text(p_value) x where coalesce(x, '') <> '')
    when coalesce(p_value #>> '{}', '') = '' then '{}'::text[]
    else array[p_value #>> '{}']
  end
$$;

-- Save a draft: new receipts are added to the existing ones; remove_receipts
-- takes files off a draft.
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
  v_new_files text[] := public.json_text_list(p_payload->'receipt_file') || public.json_text_list(p_payload->'receipt_files');
  v_remove text[] := public.json_text_list(p_payload->'remove_receipts');
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
                                 payment_source, advance_id, receipt_files, status, created_by)
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
      v_new_files,
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
      receipt_file = null,
      receipt_files = array(select f from unnest(receipt_files || v_new_files) f where not (f = any(v_remove))),
      updated_at = now()
    where id = v_id
    returning * into v_row;
  end if;

  return to_jsonb(v_row);
end;
$$;

-- Advance window data now lists every receipt of each expense.
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

  v_expenses := v_submitted + v_approved;
  v_recorded := v_drafts + v_expenses;
  v_net := v_advance.amount - v_approved;

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
        'receipt_files', to_jsonb(e.receipt_files),
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

-- 3. Job profitability --------------------------------------------------------
-- Revenue  = issued invoices for the job (not draft / cancelled / void)
-- Collected = payments received on those invoices
-- Costs    = approved or paid expenses linked to the job (this includes
--            approved advance expenses, but never the advance itself, so money
--            is not counted twice) + materials issued to the job at cost price
--            (issues minus returns)
-- Margin   = revenue - costs
-- Jobs are included when their job date falls in the period (or no period).
create or replace function public.job_profitability(p_from date default null, p_to date default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Only administrators can view job profitability' using errcode = '42501';
  end if;

  return coalesce((
    select jsonb_agg(row_to_json(t)::jsonb order by t.margin asc, t.number)
    from (
      select
        j.id,
        j.number,
        coalesce(nullif(j.title, ''), j.job_type, 'Job') as title,
        c.name as customer,
        j.status,
        j.job_date,
        coalesce(inv.revenue, 0) as revenue,
        coalesce(inv.collected, 0) as collected,
        coalesce(exp.expenses, 0) as expenses,
        coalesce(mat.materials, 0) as materials,
        coalesce(exp.expenses, 0) + coalesce(mat.materials, 0) as costs,
        coalesce(inv.revenue, 0) - coalesce(exp.expenses, 0) - coalesce(mat.materials, 0) as margin,
        case when coalesce(inv.revenue, 0) > 0
             then round(((coalesce(inv.revenue, 0) - coalesce(exp.expenses, 0) - coalesce(mat.materials, 0)) / inv.revenue) * 100, 1)
        end as margin_pct,
        coalesce(adv.open_advances, 0) as open_advances,
        coalesce(exp.by_category, '{}'::jsonb) as cost_by_category
      from public.jobs j
      left join public.customers c on c.id = j.customer_id
      left join lateral (
        select sum(i.total) as revenue, sum(i.amount_received) as collected
        from public.invoices i
        where i.job_id = j.id and i.deleted_at is null and lower(i.status) not in ('draft', 'cancelled', 'void')
      ) inv on true
      left join lateral (
        select sum(x.total) as expenses, jsonb_object_agg(x.category, x.total) as by_category
        from (
          select coalesce(e.category, 'Other') as category, sum(e.amount) as total
          from public.expenses e
          where e.job_id = j.id and e.deleted_at is null and lower(e.status) in ('approved', 'paid')
          group by 1
        ) x
      ) exp on true
      left join lateral (
        select sum(case when lower(sm.type) = 'return' then -1 else 1 end * sm.quantity * ii.cost_price) as materials
        from public.stock_movements sm
        join public.inventory_items ii on ii.id = sm.item_id
        where sm.job_id = j.id and lower(sm.type) in ('issue', 'out', 'return')
      ) mat on true
      left join lateral (
        select sum(greatest(a.amount - a.claimed, 0)) as open_advances
        from public.advances a
        where a.job_id = j.id and a.deleted_at is null and public.advance_is_open(a.status)
      ) adv on true
      where j.deleted_at is null
        and (p_from is null or j.job_date >= p_from)
        and (p_to is null or j.job_date <= p_to)
    ) t
  ), '[]'::jsonb);
end;
$$;

-- 4. Advance overview for admins ---------------------------------------------
create or replace function public.advance_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'Only administrators can view the advance overview' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'stages', coalesce((
      select jsonb_agg(jsonb_build_object('status', s.status, 'count', s.cnt, 'amount', s.amt) order by s.ord)
      from (
        select st.status, st.ord,
               count(a.id) as cnt, coalesce(sum(a.amount), 0) as amt
        from (values ('Pending Approval', 1), ('Approved', 2), ('Issued', 3), ('Under Review', 4), ('Settlement Approved', 5)) st(status, ord)
        left join public.advances a on a.deleted_at is null
          and (lower(a.status) = lower(st.status) or (st.status = 'Issued' and lower(a.status) in ('open', 'partially settled')))
        group by st.status, st.ord
      ) s
    ), '[]'::jsonb),
    -- Released money not yet backed by approved expenses or returned.
    'held_by_staff', coalesce((
      select sum(greatest(a.amount - coalesce(ap.approved, 0), 0))
      from public.advances a
      left join lateral (select sum(e.amount) as approved from public.expenses e
                         where e.advance_id = a.id and e.deleted_at is null and lower(e.status) in ('approved', 'paid')) ap on true
      where a.deleted_at is null and lower(a.status) in ('issued', 'open', 'partially settled', 'under review', 'settlement approved')
    ), 0),
    'by_staff', coalesce((
      select jsonb_agg(x order by (x->>'held')::numeric desc)
      from (
        select jsonb_build_object('staff', st.name, 'advances', count(*),
                 'held', sum(greatest(a.amount - coalesce(ap.approved, 0), 0))) as x
        from public.advances a
        join public.staff st on st.id = a.staff_id
        left join lateral (select sum(e.amount) as approved from public.expenses e
                           where e.advance_id = a.id and e.deleted_at is null and lower(e.status) in ('approved', 'paid')) ap on true
        where a.deleted_at is null and lower(a.status) in ('issued', 'open', 'partially settled', 'under review', 'settlement approved')
        group by st.name
      ) q
    ), '[]'::jsonb),
    'overdue', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', a.id, 'number', a.number, 'staff', st.name, 'job_number', j.number,
        'amount', a.amount, 'due_date', a.due_date, 'days_overdue', current_date - a.due_date,
        'drafts', (select coalesce(sum(e.amount), 0) from public.expenses e where e.advance_id = a.id and e.deleted_at is null and lower(e.status) = 'draft')
      ) order by a.due_date)
      from public.advances a
      left join public.staff st on st.id = a.staff_id
      left join public.jobs j on j.id = a.job_id
      where a.deleted_at is null and public.advance_is_open(a.status)
        and a.due_date is not null and a.due_date < current_date
    ), '[]'::jsonb),
    'waiting_review', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', a.id, 'number', a.number, 'staff', st.name, 'job_number', j.number,
        'status', a.status, 'amount', a.amount,
        'since', coalesce(a.submitted_at, a.reviewed_at, a.updated_at),
        'days_waiting', (current_date - coalesce(a.submitted_at, a.reviewed_at, a.updated_at)::date)
      ) order by coalesce(a.submitted_at, a.reviewed_at, a.updated_at))
      from public.advances a
      left join public.staff st on st.id = a.staff_id
      left join public.jobs j on j.id = a.job_id
      where a.deleted_at is null and lower(a.status) in ('under review', 'settlement approved')
    ), '[]'::jsonb)
  );
end;
$$;

-- 5. Reminders ----------------------------------------------------------------
-- * Staff: advance past its expected settlement date and not yet submitted.
-- * Admins: settlement waiting for review (or finance) for 3+ days.
-- Safe to call any number of times: each reminder is sent at most once a day.
-- Runs daily through pg_cron when available, and whenever an admin opens the
-- advance overview.
create or replace function public.send_advance_reminders()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  v_sent integer := 0;
begin
  for r in
    select a.id, a.number, a.staff_id, a.due_date, st.profile_id, j.number as job_number
    from public.advances a
    join public.staff st on st.id = a.staff_id
    left join public.jobs j on j.id = a.job_id
    where a.deleted_at is null and public.advance_is_open(a.status)
      and a.due_date is not null and a.due_date < current_date
      and st.profile_id is not null
      and not exists (select 1 from public.notifications n
                      where n.user_id = st.profile_id and n.related_to = a.number
                        and n.title = 'Advance settlement overdue' and n.created_at::date = current_date)
  loop
    perform public.notify_staff(r.staff_id, 'Advance settlement overdue',
      format('Advance %s (job %s) was due for settlement on %s. Submit your expenses in My advances.',
             r.number, coalesce(r.job_number, '—'), to_char(r.due_date, 'DD Mon YYYY')),
      r.number);
    v_sent := v_sent + 1;
  end loop;

  for r in
    select a.id, a.number, a.status, coalesce(a.submitted_at, a.reviewed_at, a.updated_at)::date as since, st.name as staff_name
    from public.advances a
    left join public.staff st on st.id = a.staff_id
    where a.deleted_at is null and lower(a.status) in ('under review', 'settlement approved')
      and coalesce(a.submitted_at, a.reviewed_at, a.updated_at)::date <= current_date - 3
      and not exists (select 1 from public.notifications n
                      where n.related_to = a.number and n.title = 'Advance settlement waiting'
                        and n.created_at::date = current_date)
  loop
    perform public.notify_admins('Advance settlement waiting',
      format('%s from %s has been %s for %s days.', r.number, coalesce(r.staff_name, 'staff'),
             case when lower(r.status) = 'under review' then 'waiting for manager review' else 'waiting for finance to close it' end,
             current_date - r.since),
      r.number);
    v_sent := v_sent + 1;
  end loop;

  return v_sent;
end;
$$;

-- Schedule daily at 08:00 (server time) when pg_cron is installed.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('tsg-advance-reminders', '0 8 * * *', 'select public.send_advance_reminders()');
  end if;
exception when others then
  raise notice 'pg_cron schedule skipped: %', sqlerrm;
end $$;

revoke all on function public.job_profitability(date, date) from public, anon;
revoke all on function public.advance_overview() from public, anon;
revoke all on function public.send_advance_reminders() from public, anon;
grant execute on function public.job_profitability(date, date) to authenticated;
grant execute on function public.advance_overview() to authenticated;
grant execute on function public.send_advance_reminders() to authenticated;
