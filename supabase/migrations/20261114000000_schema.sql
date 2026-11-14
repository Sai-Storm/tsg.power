-- TSG Power Engineering - Supabase/PostgreSQL schema
-- All business tables live in the public schema. Auth users are linked through public.profiles.

create extension if not exists pgcrypto;

------------------------------------------------------------------
-- Shared helpers
------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace function public.money(p numeric)
returns text
language sql
immutable
as $$
  select 'MMK ' || trim(to_char(coalesce(p, 0), 'FM999,999,999,999,990.00'));
$$;

------------------------------------------------------------------
-- Document numbering
------------------------------------------------------------------
create table public.document_counters (
  key text primary key,
  prefix text not null,
  next_value bigint not null default 0
);

create or replace function public.next_document_number(p_key text, p_prefix text, p_pad integer default 4)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_value bigint;
begin
  insert into public.document_counters (key, prefix, next_value)
  values (p_key, p_prefix, 1)
  on conflict (key) do update
    set next_value = public.document_counters.next_value + 1,
        prefix = excluded.prefix
  returning next_value into v_value;

  return p_prefix || lpad(v_value::text, p_pad, '0');
end;
$$;

create or replace function public.set_document_number()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_key text := tg_argv[0];
  v_prefix text := tg_argv[1];
  v_pad integer := coalesce(nullif(tg_argv[2], ''), '4')::integer;
  v_yearly boolean := coalesce(nullif(tg_argv[3], ''), '') = 'year';
begin
  if new.number is null or new.number = '' then
    if v_yearly then
      v_key := v_key || '_' || to_char(now(), 'YYYY');
      v_prefix := v_prefix || to_char(now(), 'YYYY') || '-';
    end if;
    new.number := public.next_document_number(v_key, v_prefix, v_pad);
  end if;
  return new;
end;
$$;

------------------------------------------------------------------
-- Accounts and people
------------------------------------------------------------------
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null unique,
  username text not null unique,
  name text not null,
  role text not null default 'Staff' check (role in ('Admin', 'Staff')),
  avatar text,
  phone text,
  is_active boolean not null default true,
  last_login timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.staff (
  id uuid primary key default gen_random_uuid(),
  employee_id text unique,
  name text not null,
  phone text,
  email text,
  designation text,
  join_date date,
  salary numeric(14,2),
  status text not null default 'Active',
  profile_id uuid unique references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  deleted_by uuid references public.profiles(id)
);

create table public.customers (
  id uuid primary key default gen_random_uuid(),
  number text unique,
  name text not null,
  trading_name text,
  customer_type text not null default 'Corporate',
  tax_number text,
  contact_person text,
  designation text,
  phone text,
  email text,
  additional_contacts text,
  billing_address text,
  service_sites text,
  payment_terms text,
  credit_limit numeric(14,2) default 0,
  status text not null default 'Active',
  notes text,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  deleted_by uuid references public.profiles(id)
);

create table public.suppliers (
  id uuid primary key default gen_random_uuid(),
  number text unique,
  name text not null,
  supplier_type text,
  tax_number text,
  contact text,
  phone text,
  email text,
  address text,
  payment_terms text,
  currency text not null default 'MMK',
  bank_beneficiary text,
  bank_name text,
  bank_account text,
  bank_verified text,
  status text not null default 'Active',
  documents jsonb not null default '[]'::jsonb,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  deleted_by uuid references public.profiles(id)
);

create table public.machines (
  id uuid primary key default gen_random_uuid(),
  number text unique,
  name text not null,
  customer_id uuid references public.customers(id) on delete set null,
  site_location text,
  machine_type text,
  brand text,
  model text,
  serial_no text,
  capacity numeric(14,2),
  capacity_unit text,
  fuel_type text,
  meter_hours numeric(14,2) default 0,
  install_date date,
  warranty_start date,
  warranty_until date,
  next_service_date date,
  status text not null default 'Operational',
  attachments jsonb not null default '[]'::jsonb,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  deleted_by uuid references public.profiles(id)
);

create table public.inventory_items (
  id uuid primary key default gen_random_uuid(),
  sku text not null unique,
  name text not null,
  category text,
  specification text,
  unit text not null default 'pcs',
  warehouse text,
  supplier_id uuid references public.suppliers(id) on delete set null,
  reorder_level numeric(14,2) not null default 0,
  cost_price numeric(14,2) not null default 0,
  sell_price numeric(14,2) not null default 0,
  qty_on_hand numeric(14,2) not null default 0,
  status text not null default 'Active',
  attachments jsonb not null default '[]'::jsonb,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  deleted_by uuid references public.profiles(id)
);

create table public.fixed_assets (
  id uuid primary key default gen_random_uuid(),
  number text unique,
  name text not null,
  asset_tag text,
  category text,
  purchase_date date,
  supplier_id uuid references public.suppliers(id) on delete set null,
  purchase_cost numeric(14,2) not null default 0,
  residual_value numeric(14,2) not null default 0,
  useful_life integer,
  depreciation_method text,
  accumulated_depreciation numeric(14,2) not null default 0,
  net_book_value numeric(14,2),
  location text,
  assigned_to uuid references public.staff(id) on delete set null,
  condition text not null default 'Good',
  status text not null default 'Active',
  warranty_until date,
  attachments jsonb not null default '[]'::jsonb,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  deleted_by uuid references public.profiles(id)
);

------------------------------------------------------------------
-- Operations
------------------------------------------------------------------
create table public.quotations (
  id uuid primary key default gen_random_uuid(),
  number text unique,
  date date not null default current_date,
  valid_until date,
  customer_id uuid references public.customers(id) on delete set null,
  job_type text,
  prepared_by text,
  scope_of_work text,
  items jsonb not null default '[]'::jsonb,
  tax_rate numeric(6,2) not null default 0,
  advance_percent numeric(6,2) not null default 0,
  payment_terms text,
  terms text,
  acceptance_evidence text,
  subtotal numeric(14,2) not null default 0,
  tax numeric(14,2) not null default 0,
  total numeric(14,2) not null default 0,
  status text not null default 'Draft',
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  deleted_by uuid references public.profiles(id)
);

create table public.jobs (
  id uuid primary key default gen_random_uuid(),
  number text unique,
  job_date date not null default current_date,
  job_type text,
  priority text not null default 'Normal',
  status text not null default 'Draft',
  department text,
  customer_id uuid references public.customers(id) on delete set null,
  site_location text,
  quotation_id uuid references public.quotations(id) on delete set null,
  customer_approval text,
  payment_terms text,
  title text,
  machine_id uuid references public.machines(id) on delete set null,
  equipment_type text,
  equipment_model text,
  serial_number text,
  equipment_records jsonb not null default '[]'::jsonb,
  description text,
  scope_of_work text,
  expected_result text,
  special_instructions text,
  planned_start_date date,
  planned_end_date date,
  site_visit_date date,
  team_leader uuid references public.staff(id) on delete set null,
  assigned_to uuid references public.staff(id) on delete set null,
  assigned_employees jsonb not null default '[]'::jsonb,
  assigned_vehicle uuid references public.fixed_assets(id) on delete set null,
  assignment_date date,
  responsibilities text,
  materials jsonb not null default '[]'::jsonb,
  job_amount numeric(14,2) not null default 0,
  additional_charges numeric(14,2) not null default 0,
  note text,
  notes jsonb not null default '[]'::jsonb,
  cancellation_reason text,
  invoice_id uuid,
  closed_at timestamptz,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  deleted_by uuid references public.profiles(id)
);

create table public.service_reports (
  id uuid primary key default gen_random_uuid(),
  number text unique,
  job_id uuid references public.jobs(id) on delete cascade,
  service_date date not null default current_date,
  started_at timestamptz,
  finished_at timestamptz,
  technicians jsonb not null default '[]'::jsonb,
  customer_complaint text,
  findings text,
  work_done text,
  parts_used jsonb not null default '[]'::jsonb,
  test_results text,
  recommendations text,
  attachments jsonb not null default '[]'::jsonb,
  customer_representative text,
  customer_acceptance text,
  acceptance_notes text,
  technician_signature text,
  customer_signature text,
  status text not null default 'Draft',
  submitted_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  deleted_by uuid references public.profiles(id)
);

create table public.material_requests (
  id uuid primary key default gen_random_uuid(),
  number text unique,
  job_id uuid references public.jobs(id) on delete set null,
  required_date date,
  requester_id uuid references public.staff(id) on delete set null,
  priority text not null default 'Normal',
  warehouse text,
  items jsonb not null default '[]'::jsonb,
  note text,
  status text not null default 'Pending',
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  deleted_by uuid references public.profiles(id)
);

create table public.invoices (
  id uuid primary key default gen_random_uuid(),
  number text unique,
  customer_id uuid references public.customers(id) on delete set null,
  job_id uuid references public.jobs(id) on delete set null,
  quotation_id uuid references public.quotations(id) on delete set null,
  service_report_id uuid references public.service_reports(id) on delete set null,
  date date not null default current_date,
  due_date date,
  payment_terms text,
  items jsonb not null default '[]'::jsonb,
  tax_rate numeric(6,2) not null default 0,
  subtotal numeric(14,2) not null default 0,
  tax numeric(14,2) not null default 0,
  additional_charges numeric(14,2) not null default 0,
  discount numeric(14,2) not null default 0,
  total numeric(14,2) not null default 0,
  amount_received numeric(14,2) not null default 0,
  status text not null default 'Draft',
  issued_at timestamptz,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  deleted_by uuid references public.profiles(id)
);

create table public.invoice_payments (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.invoices(id) on delete cascade,
  amount numeric(14,2) not null,
  date date not null default current_date,
  method text not null default 'Cash',
  notes text,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);

create table public.advances (
  id uuid primary key default gen_random_uuid(),
  number text unique,
  staff_id uuid not null references public.staff(id) on delete cascade,
  job_id uuid references public.jobs(id) on delete set null,
  date date not null default current_date,
  due_date date,
  amount numeric(14,2) not null,
  purpose text,
  claimed numeric(14,2) not null default 0,
  balance numeric(14,2) generated always as (greatest(amount - claimed, 0)) stored,
  status text not null default 'Pending Approval',
  issued_on date,
  issued_by uuid references public.profiles(id),
  settled_at timestamptz,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  deleted_by uuid references public.profiles(id)
);

create table public.expenses (
  id uuid primary key default gen_random_uuid(),
  number text unique,
  category text not null,
  office_type text,
  job_id uuid references public.jobs(id) on delete set null,
  supplier_id uuid references public.suppliers(id) on delete set null,
  supplier_name text,
  employee_id uuid references public.staff(id) on delete set null,
  date date not null default current_date,
  amount numeric(14,2) not null check (amount > 0),
  currency text not null default 'MMK',
  description text,
  payment_source text,
  advance_id uuid references public.advances(id) on delete set null,
  receipt_file text,
  exception_reason text,
  status text not null default 'Submitted',
  approved_by uuid references public.profiles(id),
  approved_at timestamptz,
  reimbursed_at timestamptz,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  deleted_by uuid references public.profiles(id)
);

create table public.cash_entries (
  id uuid primary key default gen_random_uuid(),
  number text unique,
  type text not null,
  date date not null default current_date,
  account text,
  reference_type text,
  source_id text,
  job_id uuid references public.jobs(id) on delete set null,
  counterparty text,
  amount numeric(14,2) not null check (amount > 0),
  method text not null default 'Cash',
  description text,
  attachment text,
  status text not null default 'Pending Approval',
  posted_at timestamptz,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  deleted_by uuid references public.profiles(id)
);

create table public.salaries (
  id uuid primary key default gen_random_uuid(),
  voucher_no text unique,
  staff_id uuid not null references public.staff(id) on delete cascade,
  salary_month text not null,
  basic_salary numeric(14,2) not null default 0,
  allowances numeric(14,2) not null default 0,
  deductions numeric(14,2) not null default 0,
  gross_pay numeric(14,2) generated always as (basic_salary + allowances) stored,
  net_pay numeric(14,2) generated always as (greatest(basic_salary + allowances - deductions, 0)) stored,
  paid_on date,
  payment_method text not null default 'Bank transfer',
  status text not null default 'Draft',
  notes text,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  deleted_by uuid references public.profiles(id)
);

create table public.stock_movements (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.inventory_items(id) on delete cascade,
  job_id uuid references public.jobs(id) on delete set null,
  request_id uuid references public.material_requests(id) on delete set null,
  type text not null check (type in ('in', 'out', 'issue', 'return')),
  quantity numeric(14,2) not null check (quantity > 0),
  note text,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.profiles(id) on delete cascade,
  title text not null,
  details text,
  related_to text,
  is_read boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.settings (
  key text primary key,
  label text not null,
  value text,
  updated_by uuid references public.profiles(id),
  updated_at timestamptz not null default now()
);

create table public.recycle_bin (
  id uuid primary key default gen_random_uuid(),
  module text not null,
  module_title text not null,
  record_id uuid,
  record jsonb not null default '{}'::jsonb,
  deleted_by uuid references public.profiles(id),
  deleted_by_name text,
  deleted_at timestamptz not null default now(),
  deletion_mode text not null default 'Restricted'
);

------------------------------------------------------------------
-- Indexes
------------------------------------------------------------------
create index idx_staff_profile on public.staff(profile_id);
create index idx_staff_status on public.staff(status);
create index idx_customers_name on public.customers(lower(name));
create index idx_customers_status on public.customers(status);
create index idx_suppliers_name on public.suppliers(lower(name));
create index idx_machines_customer on public.machines(customer_id);
create index idx_inventory_supplier on public.inventory_items(supplier_id);
create index idx_inventory_category on public.inventory_items(category);
create index idx_fixed_assets_assigned on public.fixed_assets(assigned_to);
create index idx_quotations_customer on public.quotations(customer_id);
create index idx_quotations_status on public.quotations(status);
create index idx_jobs_customer on public.jobs(customer_id);
create index idx_jobs_assigned on public.jobs(assigned_to);
create index idx_jobs_team_leader on public.jobs(team_leader);
create index idx_jobs_status on public.jobs(status);
create index idx_jobs_due on public.jobs(planned_end_date);
create index idx_service_reports_job on public.service_reports(job_id);
create index idx_service_reports_status on public.service_reports(status);
create index idx_material_requests_job on public.material_requests(job_id);
create index idx_material_requests_requester on public.material_requests(requester_id);
create index idx_invoices_customer on public.invoices(customer_id);
create index idx_invoices_job on public.invoices(job_id);
create index idx_invoices_status on public.invoices(status);
create index idx_invoice_payments_invoice on public.invoice_payments(invoice_id);
create index idx_advances_staff on public.advances(staff_id);
create index idx_advances_status on public.advances(status);
create index idx_expenses_employee on public.expenses(employee_id);
create index idx_expenses_job on public.expenses(job_id);
create index idx_expenses_status on public.expenses(status);
create index idx_cash_entries_job on public.cash_entries(job_id);
create index idx_salaries_staff on public.salaries(staff_id);
create index idx_salaries_month on public.salaries(salary_month);
create index idx_stock_movements_item on public.stock_movements(item_id);
create index idx_stock_movements_request on public.stock_movements(request_id);
create index idx_notifications_user on public.notifications(user_id, is_read);
create index idx_recycle_bin_deleted on public.recycle_bin(deleted_at desc);

------------------------------------------------------------------
-- Role helpers (used by RLS and views)
------------------------------------------------------------------
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and lower(p.role) = 'admin' and p.is_active
  );
$$;

create or replace function public.current_staff_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select s.id from public.staff s
  where s.profile_id = auth.uid() and s.deleted_at is null
  limit 1;
$$;

create or replace function public.is_job_member(p_job uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.jobs j
    where j.id = p_job
      and j.deleted_at is null
      and (
        j.assigned_to = public.current_staff_id()
        or j.team_leader = public.current_staff_id()
        or coalesce(j.assigned_employees, '[]'::jsonb) ? (public.current_staff_id()::text)
      )
  );
$$;

create or replace function public.guard_profile_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is not null
     and not (public.is_admin() or coalesce(current_setting('request.jwt.claim.role', true), '') = 'service_role') then
    new.role := old.role;
    new.is_active := old.is_active;
    new.email := old.email;
  end if;
  return new;
end;
$$;

------------------------------------------------------------------
-- Triggers
------------------------------------------------------------------
create trigger trg_profiles_updated before update on public.profiles
  for each row execute function public.set_updated_at();

create or replace function public.set_staff_employee_id()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.employee_id is null or new.employee_id = '' then
    new.employee_id := public.next_document_number('staff', 'ST-', 4);
  end if;
  return new;
end;
$$;

create trigger trg_staff_employee_id before insert on public.staff
  for each row execute function public.set_staff_employee_id();

do $$
declare t text;
begin
  foreach t in array array['staff','customers','suppliers','machines','inventory_items','fixed_assets','quotations','jobs','service_reports','material_requests','invoices','advances','expenses','cash_entries','salaries','settings']
  loop
    execute format('create trigger trg_%s_updated before update on public.%I for each row execute function public.set_updated_at()', t, t);
  end loop;
end $$;

create trigger trg_customers_number before insert on public.customers
  for each row execute function public.set_document_number('customer', 'CUS-', '4');
create trigger trg_suppliers_number before insert on public.suppliers
  for each row execute function public.set_document_number('supplier', 'SUP-', '4');
create trigger trg_machines_number before insert on public.machines
  for each row execute function public.set_document_number('machine', 'MCH-', '4');
create trigger trg_fixed_assets_number before insert on public.fixed_assets
  for each row execute function public.set_document_number('fixed_asset', 'FA-', '4');
create trigger trg_quotations_number before insert on public.quotations
  for each row execute function public.set_document_number('quotation', 'QT-', '4', 'year');
create trigger trg_jobs_number before insert on public.jobs
  for each row execute function public.set_document_number('job', 'TSG', '3');
create trigger trg_service_reports_number before insert on public.service_reports
  for each row execute function public.set_document_number('service_report', 'SR-', '4', 'year');
create trigger trg_material_requests_number before insert on public.material_requests
  for each row execute function public.set_document_number('material_request', 'MR-', '4', 'year');
create trigger trg_invoices_number before insert on public.invoices
  for each row execute function public.set_document_number('invoice', 'INV-', '4', 'year');
create trigger trg_advances_number before insert on public.advances
  for each row execute function public.set_document_number('advance', 'ADV-', '4', 'year');
create trigger trg_expenses_number before insert on public.expenses
  for each row execute function public.set_document_number('expense', 'EV-', '4', 'year');
create trigger trg_cash_entries_number before insert on public.cash_entries
  for each row execute function public.set_document_number('cash_entry', 'CASH-', '4', 'year');

create or replace function public.set_salary_voucher()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.voucher_no is null or new.voucher_no = '' then
    new.voucher_no := public.next_document_number('salary_' || to_char(now(), 'YYYY'), 'SAL-' || to_char(now(), 'YYYY') || '-', 4);
  end if;
  return new;
end;
$$;

create trigger trg_salaries_voucher before insert on public.salaries
  for each row execute function public.set_salary_voucher();

create trigger trg_profiles_guard before update on public.profiles
  for each row execute function public.guard_profile_update();

-- Stamp ownership and make staff-created records belong to the caller.
create or replace function public.stamp_created_by()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.created_by is null then
    new.created_by := auth.uid();
  end if;
  return new;
end;
$$;

create or replace function public.stamp_expense_owner()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.created_by is null then
    new.created_by := auth.uid();
  end if;
  if not public.is_admin() or new.employee_id is null then
    new.employee_id := coalesce(public.current_staff_id(), new.employee_id);
  end if;
  return new;
end;
$$;

create or replace function public.stamp_request_owner()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.created_by is null then
    new.created_by := auth.uid();
  end if;
  if not public.is_admin() or new.requester_id is null then
    new.requester_id := coalesce(public.current_staff_id(), new.requester_id);
  end if;
  return new;
end;
$$;

create or replace function public.stamp_service_report_owner()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.submitted_by := auth.uid();
  return new;
end;
$$;

create trigger trg_expenses_owner before insert on public.expenses
  for each row execute function public.stamp_expense_owner();
create trigger trg_material_requests_owner before insert on public.material_requests
  for each row execute function public.stamp_request_owner();
create trigger trg_service_reports_owner before insert on public.service_reports
  for each row execute function public.stamp_service_report_owner();

do $$
declare t text;
begin
  foreach t in array array['customers','suppliers','machines','inventory_items','fixed_assets','quotations','jobs','invoices','advances','cash_entries','salaries']
  loop
    execute format('create trigger trg_%s_created_by before insert on public.%I for each row execute function public.stamp_created_by()', t, t);
  end loop;
end $$;

-- Automatically create a profile for every Google/email sign-up. The first
-- account becomes an Admin so a fresh project can be bootstrapped.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text;
  v_username text;
  v_name text;
begin
  select case when exists (select 1 from public.profiles where role = 'Admin') then 'Staff' else 'Admin' end into v_role;

  v_username := nullif(regexp_replace(split_part(coalesce(new.email, ''), '@', 1), '[^a-zA-Z0-9._-]', '', 'g'), '');
  if v_username is null then
    v_username := 'user';
  end if;
  if exists (select 1 from public.profiles where username = v_username) then
    v_username := v_username || '_' || left(new.id::text, 4);
  end if;

  v_name := coalesce(
    nullif(new.raw_user_meta_data->>'full_name', ''),
    nullif(new.raw_user_meta_data->>'name', ''),
    nullif(split_part(coalesce(new.email, ''), '@', 1), ''),
    'User'
  );

  insert into public.profiles (id, email, username, name, role, avatar)
  values (
    new.id,
    coalesce(new.email, new.id::text || '@tsg.local'),
    v_username,
    v_name,
    v_role,
    nullif(new.raw_user_meta_data->>'avatar_url', '')
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

------------------------------------------------------------------
-- Display views (the frontend expects these aliases)
------------------------------------------------------------------
create or replace view public.v_customers
with (security_invoker = true) as
select c.*,
  c.number as code,
  c.contact_person as contact,
  c.billing_address as location,
  (select count(*) from public.machines m where m.customer_id = c.id and m.deleted_at is null) as machines
from public.customers c
where c.deleted_at is null;

create or replace view public.v_suppliers
with (security_invoker = true) as
select s.*,
  s.name as supplier,
  (select count(*) from public.inventory_items i where i.supplier_id = s.id and i.deleted_at is null) as items_supplied
from public.suppliers s
where s.deleted_at is null;

create or replace view public.v_machines
with (security_invoker = true) as
select m.*,
  m.name as machine,
  c.name as customer,
  m.machine_type as type,
  m.warranty_until as warranty
from public.machines m
left join public.customers c on c.id = m.customer_id
where m.deleted_at is null;

create or replace view public.v_inventory
with (security_invoker = true) as
select i.*,
  i.name as item,
  i.qty_on_hand as on_hand,
  i.reorder_level as reorder_at,
  case when coalesce(i.qty_on_hand, 0) <= coalesce(i.reorder_level, 0) then 'Low stock' else 'In stock' end as stock_status,
  s.name as supplier_name
from public.inventory_items i
left join public.suppliers s on s.id = i.supplier_id
where i.deleted_at is null;

create or replace view public.v_fixed_assets
with (security_invoker = true) as
select f.*,
  f.name as asset,
  f.number as code,
  f.purchase_date as purchased,
  public.money(f.purchase_cost) as cost,
  coalesce(st.name, 'Unassigned') as assigned_to_name
from public.fixed_assets f
left join public.staff st on st.id = f.assigned_to
where f.deleted_at is null;

create or replace view public.v_quotations
with (security_invoker = true) as
select q.*,
  c.name as customer,
  public.money(q.total) as amount
from public.quotations q
left join public.customers c on c.id = q.customer_id
where q.deleted_at is null;

create or replace view public.v_jobs
with (security_invoker = true) as
select j.*,
  c.name as customer_name,
  j.planned_end_date as due_date,
  coalesce(c.name || ' · ' || nullif(coalesce(j.equipment_type, j.title, ''), ''), j.title, '—') as customer_machine,
  coalesce(st.name, 'Unassigned') as assigned_to_name,
  coalesce(tl.name, 'Unassigned') as team_leader_name
from public.jobs j
left join public.customers c on c.id = j.customer_id
left join public.staff st on st.id = j.assigned_to
left join public.staff tl on tl.id = j.team_leader
where j.deleted_at is null;

create or replace view public.v_service_reports
with (security_invoker = true) as
select sr.*,
  sr.number as report,
  j.number as job_order,
  c.name as customer,
  sr.service_date as delivered,
  coalesce(p.name, '—') as prepared_by
from public.service_reports sr
left join public.jobs j on j.id = sr.job_id
left join public.customers c on c.id = j.customer_id
left join public.profiles p on p.id = sr.submitted_by
where sr.deleted_at is null;

create or replace view public.v_material_requests
with (security_invoker = true) as
select r.*,
  r.number as request,
  j.number as job_order,
  st.name as requested_by,
  r.required_date as date,
  (
    select string_agg(
      coalesce(i.name, it->>'description', 'Item') || ' × ' || coalesce(it->>'qty', '0'),
      ', '
    )
    from jsonb_array_elements(coalesce(r.items, '[]'::jsonb)) it
    left join public.inventory_items i on i.id::text = it->>'item_id'
  ) as items_display
from public.material_requests r
left join public.jobs j on j.id = r.job_id
left join public.staff st on st.id = r.requester_id
where r.deleted_at is null;

create or replace view public.v_invoices
with (security_invoker = true) as
select i.*,
  c.name as customer,
  i.date as issued,
  public.money(i.total) as amount
from public.invoices i
left join public.customers c on c.id = i.customer_id
where i.deleted_at is null;

create or replace view public.v_advances
with (security_invoker = true) as
select a.id,
  a.number as advance,
  a.date as issued,
  a.purpose,
  public.money(a.amount) as amount,
  public.money(a.claimed) as claimed,
  public.money(a.balance) as balance,
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

create or replace view public.v_expenses
with (security_invoker = true) as
select
  e.id,
  e.number as reference,
  e.number as voucher,
  'Expense claim'::text as type,
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

create or replace view public.v_cash_entries
with (security_invoker = true) as
select ce.*
from public.cash_entries ce
where ce.deleted_at is null;

create or replace view public.v_salaries
with (security_invoker = true) as
select s.id,
  s.voucher_no as voucher,
  st.name as staff_member,
  s.salary_month,
  public.money(s.net_pay) as net_pay,
  s.paid_on,
  s.status,
  s.staff_id,
  s.basic_salary,
  s.allowances,
  s.deductions,
  s.gross_pay,
  s.payment_method,
  s.notes,
  s.created_by,
  s.created_at,
  s.updated_at
from public.salaries s
left join public.staff st on st.id = s.staff_id
where s.deleted_at is null;

create or replace view public.v_staff
with (security_invoker = true) as
select s.*,
  s.name as staff_member,
  (
    select count(*) from public.jobs j
    where j.deleted_at is null
      and (j.assigned_to = s.id or j.team_leader = s.id or coalesce(j.assigned_employees, '[]'::jsonb) ? (s.id::text))
      and lower(j.status) not in ('completed', 'cancelled', 'closed - paid', 'closed - pending payment')
  ) as active_jobs
from public.staff s
where s.deleted_at is null;

create or replace view public.v_profiles
with (security_invoker = true) as
select p.id,
  p.name as user,
  p.username,
  p.role,
  p.last_login,
  p.created_at as created,
  case when p.is_active then 'Active' else 'Inactive' end as status,
  p.email,
  p.avatar,
  p.is_active,
  p.created_at,
  p.updated_at
from public.profiles p;

create or replace view public.v_notifications
with (security_invoker = true) as
select n.id,
  n.title as notification,
  n.details,
  n.created_at as received,
  n.related_to,
  case when n.is_read then 'Read' else 'Unread' end as status,
  n.is_read,
  n.user_id,
  n.created_at
from public.notifications n;

create or replace view public.v_settings
with (security_invoker = true) as
select s.key as id,
  s.label as setting,
  s.value as current_value,
  p.name as last_updated_by,
  s.updated_at as updated,
  s.updated_at as created_at,
  s.key,
  s.value
from public.settings s
left join public.profiles p on p.id = s.updated_by;

create or replace view public.v_recycle_bin
with (security_invoker = true) as
select r.id,
  r.module_title as module,
  coalesce(r.record->>'number', r.record->>'name', r.record->>'reference', r.record_id::text, '—') as record,
  r.deleted_by_name as deleted_by,
  r.deleted_at as deleted_date,
  r.deletion_mode,
  r.record_id,
  r.deleted_at as created_at
from public.recycle_bin r;
