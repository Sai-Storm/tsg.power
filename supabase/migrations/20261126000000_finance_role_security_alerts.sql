-- ============================================================================
-- Finance role, private files, delivery of alerts, purchase requests,
-- receivables, machine service reminders and the monthly management report.
-- Safe to run more than once.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 0. Database version: the app compares this with the version it was built
--    for and shows "Database update needed" instead of confusing errors.
-- ---------------------------------------------------------------------------
create or replace function public.schema_version()
returns text language sql immutable as $$ select '20261126000000'::text $$;
grant execute on function public.schema_version() to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 1. Finance role
--    Admin   = manager: approves requests and settlements (and can do everything)
--    Finance = releases money, settles advances, sees cash and invoices
--    Staff   = own work only
--    Nobody may approve, release or settle their own advance.
-- ---------------------------------------------------------------------------
do $$
declare c record;
begin
  for c in select conname from pg_constraint
           where conrelid = 'public.profiles'::regclass and contype = 'c' and pg_get_constraintdef(oid) ilike '%role%'
  loop
    execute format('alter table public.profiles drop constraint %I', c.conname);
  end loop;
end $$;
alter table public.profiles add constraint profiles_role_check check (role in ('Admin', 'Finance', 'Staff'));

create or replace function public.is_finance()
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (select 1 from public.profiles p
                 where p.id = auth.uid() and lower(p.role) in ('admin', 'finance') and p.is_active);
$$;
grant execute on function public.is_finance() to authenticated;

-- Finance users are also employees: they keep every staff self-service right.
create or replace function public.is_staff()
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (select 1 from public.profiles p
                 where p.id = auth.uid() and lower(p.role) in ('staff', 'finance') and p.is_active);
$$;

-- Finance users get a staff record like staff do (advances, claims, schedule).
do $$
declare v_def text;
begin
  v_def := pg_get_functiondef('public.sync_staff_from_profile()'::regprocedure);
  v_def := replace(v_def, $r$lower(coalesce(new.role, '')) = 'staff'$r$, $r$lower(coalesce(new.role, '')) in ('staff', 'finance')$r$);
  v_def := replace(v_def, $r$lower(coalesce(old.role, '')) = 'staff'$r$, $r$lower(coalesce(old.role, '')) in ('staff', 'finance')$r$);
  v_def := replace(v_def, $r$lower(coalesce(new.role, '')) <> 'staff'$r$, $r$lower(coalesce(new.role, '')) not in ('staff', 'finance')$r$);
  execute v_def;
exception when undefined_function then
  raise notice 'sync_staff_from_profile not found, skipped';
end $$;

-- Money tables: Finance may read and work on them (the workflow functions
-- below decide which steps each role may take).
do $$
declare t text;
begin
  foreach t in array array['advances', 'expenses', 'cash_entries', 'invoices', 'invoice_payments',
                           'advance_submissions', 'advance_submission_items', 'advance_approvals',
                           'advance_returns', 'advance_reimbursements']
  loop
    if to_regclass('public.' || t) is not null then
      execute format('drop policy if exists %I on public.%I', t || '_finance', t);
      execute format('create policy %I on public.%I for all to authenticated using (public.is_finance()) with check (public.is_finance())', t || '_finance', t);
    end if;
  end loop;
end $$;
drop policy if exists jobs_finance_read on public.jobs;
create policy jobs_finance_read on public.jobs for select to authenticated using (public.is_finance());

-- Steps Finance may take: release money, settle/close, cash board and reports.
-- (Approving requests and reviewing settlements stays with Admin.)
do $$
declare
  f text;
  v_def text;
begin
  foreach f in array array['public.issue_advance(uuid, jsonb)', 'public.reconcile_advance(uuid, jsonb)',
                           'public.settle_advance(uuid, numeric)', 'public.cash_board(date, date)',
                           'public.advance_overview()', 'public.job_profitability(date, date)',
                           'public.advance_for_expenses(uuid)', 'public.record_invoice_payment(uuid, jsonb)']
  loop
    begin
      v_def := pg_get_functiondef(f::regprocedure);
      execute replace(v_def, 'public.is_admin()', 'public.is_finance()');
    exception when undefined_function then
      raise notice '% not found, skipped', f;
    end;
  end loop;

  -- Finance may pay an approved claim and post an approved cash entry,
  -- but approving them stays with Admin.
  begin
    v_def := pg_get_functiondef('public.set_expense_status(uuid, text)'::regprocedure);
    execute replace(v_def, 'if not public.is_admin() then',
      $r$if not (public.is_admin() or (public.is_finance() and lower(p_status) = 'paid')) then$r$);
    v_def := pg_get_functiondef('public.set_cash_entry_status(uuid, text)'::regprocedure);
    execute replace(v_def, 'if not public.is_admin() then',
      $r$if not (public.is_admin() or (public.is_finance() and lower(p_status) = 'posted')) then$r$);
  exception when undefined_function then
    raise notice 'status functions not found, skipped';
  end;

  -- Lists: Finance sees the same company-wide rows as Admin.
  foreach f in array array['public.v_expenses', 'public.v_advances']
  loop
    if to_regclass(f) is not null then
      execute format('create or replace view %s with (security_invoker = true) as %s', f,
                     replace(pg_get_viewdef(f::regclass, true), 'is_admin()', 'is_finance()'));
    end if;
  end loop;
end $$;

-- Separation of duties, enforced on the data itself so no screen can skip it.
create or replace function public.guard_own_advance()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if auth.uid() is null then return new; end if;  -- system jobs (cron, migrations)
  if new.status is distinct from old.status
     and lower(new.status) in ('approved', 'rejected', 'issued', 'settlement approved', 'settled')
     and lower(coalesce(old.status, '')) <> 'under review'           -- "return to staff" goes back to Issued
     and new.staff_id is not null and new.staff_id = public.current_staff_id() then
    raise exception 'You cannot approve, release or settle your own advance. Another manager or finance user must do it.'
      using errcode = '42501';
  end if;
  if new.status is distinct from old.status and lower(old.status) = 'under review'
     and new.staff_id = public.current_staff_id() then
    raise exception 'You cannot review your own advance settlement.' using errcode = '42501';
  end if;
  return new;
end;
$$;
drop trigger if exists trg_guard_own_advance on public.advances;
create trigger trg_guard_own_advance before update of status on public.advances
  for each row execute function public.guard_own_advance();

create or replace function public.guard_own_expense_review()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if auth.uid() is null then return new; end if;
  if new.advance_id is not null and new.status is distinct from old.status
     and lower(new.status) in ('approved', 'rejected')
     and new.employee_id is not null and new.employee_id = public.current_staff_id() then
    raise exception 'You cannot approve or reject your own expenses.' using errcode = '42501';
  end if;
  return new;
end;
$$;
drop trigger if exists trg_guard_own_expense_review on public.expenses;
create trigger trg_guard_own_expense_review before update of status on public.expenses
  for each row execute function public.guard_own_expense_review();

-- Finance users hear about the steps that are theirs.
create or replace function public.notify_finance(p_title text, p_details text, p_related text)
returns void language sql security definer set search_path = public
as $$
  insert into public.notifications (user_id, title, details, related_to)
  select p.id, p_title, p_details, p_related from public.profiles p
  where lower(p.role) = 'finance' and p.is_active;
$$;

create or replace function public.trg_notify_finance_on_advance()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  if new.status is distinct from old.status then
    if lower(new.status) = 'approved' then
      perform public.notify_finance('Advance ready to release',
        format('%s for %s MMK was approved. Release the money.', new.number, to_char(round(new.amount), 'FM999,999,999,990')), new.number);
    elsif lower(new.status) = 'settlement approved' then
      perform public.notify_finance('Advance ready to settle',
        format('The settlement for %s was approved. Settle the balance and close it.', new.number), new.number);
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists trg_advances_notify_finance on public.advances;
create trigger trg_advances_notify_finance after update of status on public.advances
  for each row execute function public.trg_notify_finance_on_advance();

-- ---------------------------------------------------------------------------
-- 2. Private files
--    The bucket is no longer public: files open through short-lived signed
--    links. Receipts and other money documents are readable only by the person
--    who uploaded them and by Admin/Finance. Job, machine and report files stay
--    readable by every signed-in user.
-- ---------------------------------------------------------------------------
create or replace function public.is_private_attachment(p_name text)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (select 1 from public.expenses e
                 where strpos(coalesce(e.receipt_file, ''), p_name) > 0
                    or exists (select 1 from unnest(coalesce(e.receipt_files, '{}')) f where strpos(f, p_name) > 0))
      or exists (select 1 from public.cash_entries c where strpos(coalesce(c.attachment, ''), p_name) > 0);
$$;
grant execute on function public.is_private_attachment(text) to authenticated;

do $$
begin
  if to_regclass('storage.buckets') is not null then
    update storage.buckets set public = false where id = 'attachments';
  end if;
  if to_regclass('storage.objects') is not null then
    execute 'drop policy if exists attachments_read on storage.objects';
    execute $p$create policy attachments_read on storage.objects for select to authenticated using (
      bucket_id = 'attachments' and (
        owner = auth.uid()
        or (storage.foldername(name))[1] = auth.uid()::text
        or public.is_finance()
        or not public.is_private_attachment(name)))$p$;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 3. Alerts by email and Telegram
--    Every notification for a person who opted in is queued in
--    outbound_messages; the deliver-messages edge function sends the queue.
-- ---------------------------------------------------------------------------
alter table public.profiles add column if not exists email_alerts boolean not null default false;
alter table public.profiles add column if not exists telegram_chat_id text;

create table if not exists public.outbound_messages (
  id uuid primary key default gen_random_uuid(),
  channel text not null check (channel in ('email', 'telegram')),
  recipient text not null,
  subject text,
  body text not null,
  status text not null default 'Queued' check (status in ('Queued', 'Sent', 'Failed')),
  attempts integer not null default 0,
  error text,
  related_to text,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
create index if not exists idx_outbound_queued on public.outbound_messages(status, created_at);
alter table public.outbound_messages enable row level security;
drop policy if exists outbound_messages_admin on public.outbound_messages;
create policy outbound_messages_admin on public.outbound_messages for select to authenticated using (public.is_admin());

create or replace function public.queue_notification_delivery()
returns trigger language plpgsql security definer set search_path = public
as $$
declare p public.profiles;
begin
  select * into p from public.profiles where id = new.user_id and is_active;
  if p.id is null then return new; end if;
  if p.email_alerts and coalesce(p.email, '') <> '' then
    insert into public.outbound_messages (channel, recipient, subject, body, related_to)
    values ('email', p.email, 'TSG Power: ' || new.title, coalesce(new.details, new.title), new.related_to);
  end if;
  if coalesce(trim(p.telegram_chat_id), '') <> '' then
    insert into public.outbound_messages (channel, recipient, body, related_to)
    values ('telegram', trim(p.telegram_chat_id), '*' || new.title || '*' || coalesce(E'\n' || new.details, ''), new.related_to);
  end if;
  return new;
end;
$$;
drop trigger if exists trg_notifications_delivery on public.notifications;
create trigger trg_notifications_delivery after insert on public.notifications
  for each row execute function public.queue_notification_delivery();

-- Live unread badge: notifications are streamed through Supabase Realtime.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'notifications') then
    execute 'alter publication supabase_realtime add table public.notifications';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 4. Purchase requests (low stock -> one click)
-- ---------------------------------------------------------------------------
create table if not exists public.purchase_requests (
  id uuid primary key default gen_random_uuid(),
  number text unique,
  item_id uuid not null references public.inventory_items(id) on delete cascade,
  supplier_id uuid references public.suppliers(id) on delete set null,
  quantity numeric(14,2) not null check (quantity > 0),
  estimated_cost numeric(14,2) not null default 0,
  status text not null default 'Pending' check (status in ('Pending', 'Ordered', 'Received', 'Cancelled')),
  note text,
  ordered_at timestamptz,
  received_at timestamptz,
  created_by uuid references public.profiles(id) default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
alter table public.purchase_requests enable row level security;
drop policy if exists purchase_requests_admin on public.purchase_requests;
create policy purchase_requests_admin on public.purchase_requests for all to authenticated
  using (public.is_finance()) with check (public.is_finance());

create or replace function public.stamp_purchase_request()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  if new.number is null then
    new.number := public.next_document_number('purchase_' || to_char(now(), 'YYYY'), 'PR-' || to_char(now(), 'YYYY') || '-', 4);
  end if;
  new.updated_at := now();
  return new;
end;
$$;
drop trigger if exists trg_purchase_requests_stamp on public.purchase_requests;
create trigger trg_purchase_requests_stamp before insert or update on public.purchase_requests
  for each row execute function public.stamp_purchase_request();

create or replace view public.v_purchase_requests with (security_invoker = true) as
select pr.id, pr.number as request, i.name as item, i.sku, pr.quantity, i.unit,
  coalesce(s.name, '—') as supplier, pr.estimated_cost, pr.status, pr.created_at::date as requested,
  pr.received_at::date as received, pr.note, pr.item_id, pr.supplier_id, i.qty_on_hand as on_hand, i.reorder_level,
  pr.created_at, pr.updated_at
from public.purchase_requests pr
join public.inventory_items i on i.id = pr.item_id
left join public.suppliers s on s.id = pr.supplier_id
where pr.deleted_at is null;
grant select on public.v_purchase_requests to authenticated;

-- Items at or below their reorder level, with any request already open.
create or replace function public.low_stock_items()
returns jsonb language sql stable security definer set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', i.id, 'name', i.name, 'sku', i.sku, 'unit', i.unit, 'on_hand', i.qty_on_hand,
    'reorder_level', i.reorder_level, 'supplier', s.name, 'cost_price', i.cost_price,
    'suggested', greatest(i.reorder_level * 2 - i.qty_on_hand, 1),
    'open_request', (select pr.number from public.purchase_requests pr
                     where pr.item_id = i.id and pr.deleted_at is null and pr.status in ('Pending', 'Ordered')
                     order by pr.created_at desc limit 1)
  ) order by (i.qty_on_hand - i.reorder_level), i.name), '[]'::jsonb)
  from public.inventory_items i
  left join public.suppliers s on s.id = i.supplier_id
  where i.deleted_at is null and lower(i.status) = 'active' and i.reorder_level > 0 and i.qty_on_hand <= i.reorder_level;
$$;
grant execute on function public.low_stock_items() to authenticated;

create or replace function public.create_purchase_request(p_item uuid, p_quantity numeric default null, p_note text default null)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare
  i public.inventory_items;
  r public.purchase_requests;
  v_qty numeric;
begin
  if not public.is_finance() then
    raise exception 'Only administrators and finance can create purchase requests' using errcode = '42501';
  end if;
  select * into i from public.inventory_items where id = p_item and deleted_at is null;
  if i.id is null then raise exception 'Inventory item not found'; end if;
  v_qty := coalesce(nullif(p_quantity, 0), greatest(i.reorder_level * 2 - i.qty_on_hand, 1));
  insert into public.purchase_requests (item_id, supplier_id, quantity, estimated_cost, note)
  values (i.id, i.supplier_id, v_qty, round(v_qty * i.cost_price, 2), p_note)
  returning * into r;
  return to_jsonb(r);
end;
$$;

-- Ordered -> Received adds the quantity to stock.
create or replace function public.set_purchase_request_status(p_request uuid, p_status text)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare r public.purchase_requests;
begin
  if not public.is_finance() then
    raise exception 'Only administrators and finance can update purchase requests' using errcode = '42501';
  end if;
  select * into r from public.purchase_requests where id = p_request and deleted_at is null for update;
  if r.id is null then raise exception 'Purchase request not found'; end if;
  if r.status in ('Received', 'Cancelled') then
    raise exception 'Purchase request % is already %.', r.number, lower(r.status);
  end if;
  if p_status not in ('Ordered', 'Received', 'Cancelled') then raise exception 'Invalid status'; end if;
  if p_status = 'Received' then
    update public.inventory_items set qty_on_hand = qty_on_hand + r.quantity, updated_at = now() where id = r.item_id;
    insert into public.stock_movements (item_id, type, quantity, note, created_by)
    values (r.item_id, 'in', r.quantity, 'Received on ' || r.number, auth.uid());
  end if;
  update public.purchase_requests set status = p_status,
    ordered_at = case when p_status = 'Ordered' then now() else ordered_at end,
    received_at = case when p_status = 'Received' then now() else received_at end
  where id = p_request returning * into r;
  return to_jsonb(r);
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Receivables: what each customer owes, oldest first.
-- ---------------------------------------------------------------------------
create or replace function public.receivables_summary()
returns jsonb language plpgsql stable security definer set search_path = public
as $$
begin
  if not public.is_finance() then
    raise exception 'Only administrators and finance can view receivables' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(c order by (c->>'overdue')::numeric desc, (c->>'outstanding')::numeric desc)
    from (
      select jsonb_build_object(
        'customer_id', cu.id, 'customer', cu.name, 'email', cu.email, 'phone', cu.phone,
        'outstanding', sum(inv.outstanding),
        'overdue', coalesce(sum(inv.outstanding) filter (where inv.due_date < current_date), 0),
        'oldest_days', max(greatest(current_date - inv.due_date, 0)),
        'invoices', jsonb_agg(jsonb_build_object(
          'id', inv.id, 'number', inv.number, 'date', inv.date, 'due_date', inv.due_date, 'job_number', inv.job_number,
          'total', inv.total, 'received', inv.amount_received, 'outstanding', inv.outstanding,
          'days_overdue', greatest(current_date - inv.due_date, 0)) order by inv.due_date nulls last)
      ) as c
      from (
        select i.*, i.total - i.amount_received as outstanding, j.number as job_number
        from public.invoices i left join public.jobs j on j.id = i.job_id
        where i.deleted_at is null and lower(i.status) not in ('draft', 'cancelled', 'void')
          and i.total - i.amount_received > 0
      ) inv
      join public.customers cu on cu.id = inv.customer_id
      group by cu.id
    ) x
  ), '[]'::jsonb);
end;
$$;

-- Statement of account for one customer: every invoice and payment.
create or replace function public.customer_statement(p_customer uuid, p_from date default null, p_to date default null)
returns jsonb language plpgsql stable security definer set search_path = public
as $$
declare cu public.customers;
begin
  if not public.is_finance() then
    raise exception 'Only administrators and finance can view statements' using errcode = '42501';
  end if;
  select * into cu from public.customers where id = p_customer;
  if cu.id is null then raise exception 'Customer not found'; end if;
  return jsonb_build_object(
    'customer', jsonb_build_object('name', cu.name, 'address', cu.billing_address, 'email', cu.email, 'phone', cu.phone, 'contact', cu.contact_person),
    'lines', coalesce((
      select jsonb_agg(l order by l->>'date', l->>'kind' desc) from (
        select jsonb_build_object('date', i.date, 'kind', 'Invoice', 'reference', i.number, 'due_date', i.due_date,
                                  'debit', i.total, 'credit', 0) as l
        from public.invoices i
        where i.customer_id = p_customer and i.deleted_at is null and lower(i.status) not in ('draft', 'cancelled', 'void')
          and (p_from is null or i.date >= p_from) and (p_to is null or i.date <= p_to)
        union all
        select jsonb_build_object('date', pay.date, 'kind', 'Payment', 'reference', i.number || coalesce(' · ' || pay.method, ''),
                                  'due_date', null, 'debit', 0, 'credit', pay.amount)
        from public.invoice_payments pay join public.invoices i on i.id = pay.invoice_id
        where i.customer_id = p_customer and i.deleted_at is null
          and (p_from is null or pay.date >= p_from) and (p_to is null or pay.date <= p_to)
      ) s
    ), '[]'::jsonb)
  );
end;
$$;

-- Queue a payment reminder email to the customer (and tell finance).
create or replace function public.send_invoice_reminder(p_customer uuid)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare
  cu public.customers;
  v_list text;
  v_total numeric;
begin
  if not public.is_finance() then
    raise exception 'Only administrators and finance can send reminders' using errcode = '42501';
  end if;
  select * into cu from public.customers where id = p_customer;
  if cu.id is null then raise exception 'Customer not found'; end if;
  select string_agg(format('%s  due %s  %s MMK', i.number, coalesce(to_char(i.due_date, 'DD Mon YYYY'), '—'),
                           to_char(round(i.total - i.amount_received), 'FM999,999,999,990')), E'\n' order by i.due_date),
         sum(i.total - i.amount_received)
    into v_list, v_total
  from public.invoices i
  where i.customer_id = p_customer and i.deleted_at is null and lower(i.status) not in ('draft', 'cancelled', 'void')
    and i.total - i.amount_received > 0;
  if v_total is null then raise exception '% has nothing outstanding.', cu.name; end if;
  if coalesce(cu.email, '') = '' then
    raise exception '% has no email address. Add one on the customer record, or print the statement instead.', cu.name;
  end if;
  insert into public.outbound_messages (channel, recipient, subject, body, related_to)
  values ('email', cu.email, 'Payment reminder from TSG Power Engineering',
          format(E'Dear %s,\n\nOur records show the following invoices are still open:\n\n%s\n\nTotal outstanding: %s MMK\n\nIf you have already paid, please ignore this message. Thank you.\n\nTSG Power Engineering Co.,Ltd.',
                 coalesce(nullif(cu.contact_person, ''), cu.name), v_list, to_char(round(v_total), 'FM999,999,999,990')),
          cu.name);
  return jsonb_build_object('email', cu.email, 'outstanding', v_total);
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Monthly management report
-- ---------------------------------------------------------------------------
create or replace function public.management_report(p_month date)
returns jsonb language plpgsql stable security definer set search_path = public
as $$
declare
  v_from date := date_trunc('month', p_month)::date;
  v_to date := (date_trunc('month', p_month) + interval '1 month - 1 day')::date;
begin
  if not public.is_finance() then
    raise exception 'Only administrators and finance can view the management report' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'from', v_from, 'to', v_to,
    'invoiced', coalesce((select sum(total) from public.invoices where deleted_at is null and lower(status) not in ('draft', 'cancelled', 'void') and date between v_from and v_to), 0),
    'collected', coalesce((select sum(p.amount) from public.invoice_payments p join public.invoices i on i.id = p.invoice_id where i.deleted_at is null and p.date between v_from and v_to), 0),
    'expenses', coalesce((select sum(amount) from public.expenses where deleted_at is null and lower(status) in ('approved', 'paid') and date between v_from and v_to), 0),
    'cash_in', coalesce((select sum(cash_in) from public.cash_movements(v_from, v_to)), 0),
    'cash_out', coalesce((select sum(cash_out) from public.cash_movements(v_from, v_to)), 0),
    'expense_by_category', coalesce((
      select jsonb_agg(jsonb_build_object('category', category, 'amount', amount) order by amount desc) from (
        select coalesce(nullif(category, ''), 'Other') as category, sum(amount) as amount from public.expenses
        where deleted_at is null and lower(status) in ('approved', 'paid') and date between v_from and v_to
        group by 1) e), '[]'::jsonb),
    'jobs', coalesce((
      select jsonb_agg(j order by (j->>'margin')::numeric) from (
        select jsonb_build_object('number', jb.number, 'title', jb.title, 'customer', cu.name,
          'revenue', rev.v, 'costs', cost.v, 'margin', rev.v - cost.v) as j
        from public.jobs jb
        left join public.customers cu on cu.id = jb.customer_id
        cross join lateral (select coalesce(sum(i.total), 0) v from public.invoices i
          where i.job_id = jb.id and i.deleted_at is null and lower(i.status) not in ('draft', 'cancelled', 'void') and i.date between v_from and v_to) rev
        cross join lateral (select coalesce((select sum(e.amount) from public.expenses e
            where e.job_id = jb.id and e.deleted_at is null and lower(e.status) in ('approved', 'paid') and e.date between v_from and v_to), 0)
          + coalesce((select sum(case when m.type = 'return' then -1 else 1 end * m.quantity * it.cost_price)
            from public.stock_movements m join public.inventory_items it on it.id = m.item_id
            where m.job_id = jb.id and m.type in ('issue', 'return') and m.created_at::date between v_from and v_to), 0) v) cost
        where jb.deleted_at is null and (rev.v <> 0 or cost.v <> 0)
      ) x), '[]'::jsonb),
    'receivables', coalesce((select sum(total - amount_received) from public.invoices where deleted_at is null and lower(status) not in ('draft', 'cancelled', 'void') and total - amount_received > 0), 0),
    'open_advances', coalesce((select sum(greatest(a.amount - coalesce(a.claimed, 0), 0)) from public.advances a where a.deleted_at is null and lower(a.status) not in ('settled', 'closed', 'rejected', 'pending approval', 'approved')), 0)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Daily alerts: low stock, machines due for service, overdue invoices,
--    and (on the 1st) "monthly report ready". Each alert at most once a day.
-- ---------------------------------------------------------------------------
create or replace function public.notify_managers(p_title text, p_details text, p_related text)
returns integer language plpgsql security definer set search_path = public
as $$
declare v integer;
begin
  if exists (select 1 from public.notifications n where n.title = p_title and n.related_to = p_related and n.created_at::date = current_date) then
    return 0;
  end if;
  insert into public.notifications (user_id, title, details, related_to)
  select p.id, p_title, p_details, p_related from public.profiles p
  where lower(p.role) in ('admin', 'finance') and p.is_active;
  get diagnostics v = row_count;
  return case when v > 0 then 1 else 0 end;
end;
$$;

create or replace function public.send_daily_alerts()
returns integer language plpgsql security definer set search_path = public
as $$
declare
  r record;
  v_sent integer := 0;
begin
  if auth.uid() is not null and not public.is_finance() then
    raise exception 'Only administrators and finance can send alerts' using errcode = '42501';
  end if;

  -- Low stock (once a week per item, while no purchase request is open)
  for r in
    select i.id, i.name, i.sku, i.qty_on_hand, i.reorder_level, i.unit from public.inventory_items i
    where i.deleted_at is null and lower(i.status) = 'active' and i.reorder_level > 0 and i.qty_on_hand <= i.reorder_level
      and not exists (select 1 from public.purchase_requests pr where pr.item_id = i.id and pr.deleted_at is null and pr.status in ('Pending', 'Ordered'))
      and not exists (select 1 from public.notifications n where n.title = 'Low stock' and n.related_to = i.sku and n.created_at > now() - interval '7 days')
  loop
    v_sent := v_sent + public.notify_managers('Low stock',
      format('%s (%s): %s %s left, reorder level %s. Create a purchase request in Inventory.', r.name, r.sku,
             trim(to_char(r.qty_on_hand, 'FM999,999,990.##')), r.unit, trim(to_char(r.reorder_level, 'FM999,999,990.##'))), r.sku);
  end loop;

  -- Machines due for service in the next 14 days (once per machine per due date)
  for r in
    select m.number, m.name, m.next_service_date, cu.name as customer from public.machines m
    left join public.customers cu on cu.id = m.customer_id
    where m.deleted_at is null and m.next_service_date is not null
      and m.next_service_date <= current_date + 14
      and m.next_service_date >= current_date - 30
      and not exists (select 1 from public.notifications n where n.title = 'Machine service due'
                      and n.related_to = m.number and n.details like '%' || to_char(m.next_service_date, 'DD Mon YYYY') || '%')
  loop
    v_sent := v_sent + public.notify_managers('Machine service due',
      format('%s (%s) for %s is due for service on %s. Create a job order from Machines.', r.name, r.number,
             coalesce(r.customer, 'no customer'), to_char(r.next_service_date, 'DD Mon YYYY')), r.number);
  end loop;

  -- Overdue invoices (once a week per invoice)
  for r in
    select i.number, i.due_date, i.total - i.amount_received as outstanding, cu.name as customer from public.invoices i
    left join public.customers cu on cu.id = i.customer_id
    where i.deleted_at is null and lower(i.status) not in ('draft', 'cancelled', 'void')
      and i.total - i.amount_received > 0 and i.due_date < current_date
      and not exists (select 1 from public.notifications n where n.title = 'Invoice overdue' and n.related_to = i.number and n.created_at > now() - interval '7 days')
  loop
    v_sent := v_sent + public.notify_managers('Invoice overdue',
      format('%s for %s: %s MMK outstanding, %s days overdue. See Receivables.', r.number, coalesce(r.customer, '—'),
             to_char(round(r.outstanding), 'FM999,999,999,990'), current_date - r.due_date), r.number);
  end loop;

  -- Monthly management report is ready (first days of the month)
  if extract(day from current_date) <= 3 then
    v_sent := v_sent + public.notify_managers('Monthly report ready',
      format('The management report for %s is ready in Reports > Management report.', to_char(current_date - interval '1 month', 'FMMonth YYYY')),
      'management-report:' || to_char(current_date - interval '1 month', 'YYYY-MM'));
  end if;

  return v_sent;
end;
$$;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('tsg-daily-alerts', '5 8 * * *', 'select public.send_daily_alerts()');
  end if;
exception when others then
  raise notice 'pg_cron schedule skipped: %', sqlerrm;
end $$;

-- send_advance_reminders: Finance may run it too.
do $$
declare v_def text;
begin
  v_def := pg_get_functiondef('public.send_advance_reminders()'::regprocedure);
  if v_def not ilike '%is_finance%' then
    v_def := regexp_replace(v_def, 'begin\s+for r in', E'begin\n  if auth.uid() is not null and not public.is_finance() then\n    raise exception ''Only administrators and finance can send reminders'' using errcode = ''42501'';\n  end if;\n  for r in');
    execute v_def;
  end if;
exception when undefined_function then null;
end $$;

-- ---------------------------------------------------------------------------
-- 8. Grants
-- ---------------------------------------------------------------------------
revoke all on function public.create_purchase_request(uuid, numeric, text) from public, anon;
revoke all on function public.set_purchase_request_status(uuid, text) from public, anon;
revoke all on function public.receivables_summary() from public, anon;
revoke all on function public.customer_statement(uuid, date, date) from public, anon;
revoke all on function public.send_invoice_reminder(uuid) from public, anon;
revoke all on function public.management_report(date) from public, anon;
revoke all on function public.send_daily_alerts() from public, anon;
revoke all on function public.notify_managers(text, text, text) from public, anon, authenticated;
revoke all on function public.notify_finance(text, text, text) from public, anon, authenticated;
grant execute on function public.create_purchase_request(uuid, numeric, text) to authenticated;
grant execute on function public.set_purchase_request_status(uuid, text) to authenticated;
grant execute on function public.receivables_summary() to authenticated;
grant execute on function public.customer_statement(uuid, date, date) to authenticated;
grant execute on function public.send_invoice_reminder(uuid) to authenticated;
grant execute on function public.management_report(date) to authenticated;
grant execute on function public.send_daily_alerts() to authenticated;
grant select, insert, update on public.purchase_requests to authenticated;
grant select on public.outbound_messages to authenticated;

notify pgrst, 'reload schema';
