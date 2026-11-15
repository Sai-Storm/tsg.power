-- Move customer management from Admin to Staff.
-- Staff can create, edit and soft-delete customer records. All signed-in
-- users keep read access because jobs, quotations and invoices reference
-- customer data.

create or replace function public.is_staff()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and lower(p.role) = 'staff' and p.is_active
  );
$$;

drop policy if exists customers_admin on public.customers;
drop policy if exists customers_staff_write on public.customers;
create policy customers_staff_write on public.customers
  for all to authenticated using (public.is_staff()) with check (public.is_staff());

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
  if not public.is_admin() and not (lower(p_resource) = 'customers' and public.is_staff()) then
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
