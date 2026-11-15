-- Row Level Security and privilege grants.
-- Admins manage everything. Staff get least-privilege access to the modules
-- exposed by the frontend (assigned jobs, reports, requests, own expenses).

do $$
declare t text;
begin
  foreach t in array array[
    'profiles','staff','customers','suppliers','machines','inventory_items','fixed_assets',
    'quotations','jobs','service_reports','material_requests','invoices','invoice_payments',
    'advances','expenses','cash_entries','salaries','stock_movements','notifications',
    'settings','recycle_bin','document_counters'
  ]
  loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;

------------------------------------------------------------------
-- Profiles / accounts
------------------------------------------------------------------
create policy profiles_select on public.profiles
  for select to authenticated
  using (id = auth.uid() or public.is_admin());

create policy profiles_update on public.profiles
  for update to authenticated
  using (id = auth.uid() or public.is_admin())
  with check (id = auth.uid() or public.is_admin());

create policy profiles_insert on public.profiles
  for insert to authenticated
  with check (public.is_admin());

------------------------------------------------------------------
-- Read-only master data for all signed-in users
------------------------------------------------------------------
create policy customers_staff_write on public.customers
  for all to authenticated using (public.is_staff()) with check (public.is_staff());
create policy customers_read on public.customers
  for select to authenticated using (true);

create policy suppliers_admin on public.suppliers
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy suppliers_read on public.suppliers
  for select to authenticated using (true);

create policy machines_admin on public.machines
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy machines_read on public.machines
  for select to authenticated using (true);

create policy inventory_admin on public.inventory_items
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy inventory_read on public.inventory_items
  for select to authenticated using (true);

create policy fixed_assets_admin on public.fixed_assets
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy fixed_assets_read on public.fixed_assets
  for select to authenticated using (true);

create policy staff_admin on public.staff
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy staff_read on public.staff
  for select to authenticated using (true);

create policy quotations_admin on public.quotations
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy quotations_read on public.quotations
  for select to authenticated using (true);

------------------------------------------------------------------
-- Jobs
------------------------------------------------------------------
create policy jobs_admin on public.jobs
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy jobs_staff_read on public.jobs
  for select to authenticated using (public.is_job_member(id));
create policy jobs_staff_insert on public.jobs
  for insert to authenticated with check (true);
create policy jobs_staff_update on public.jobs
  for update to authenticated
  using (public.is_job_member(id))
  with check (public.is_job_member(id));

------------------------------------------------------------------
-- Service reports
------------------------------------------------------------------
create policy service_reports_admin on public.service_reports
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy service_reports_staff_read on public.service_reports
  for select to authenticated
  using (submitted_by = auth.uid() or public.is_job_member(job_id));
create policy service_reports_staff_insert on public.service_reports
  for insert to authenticated
  with check (submitted_by = auth.uid() and public.is_job_member(job_id));
create policy service_reports_staff_update on public.service_reports
  for update to authenticated
  using (submitted_by = auth.uid() and lower(status) in ('draft', 'rejected'))
  with check (submitted_by = auth.uid());

------------------------------------------------------------------
-- Material requests
------------------------------------------------------------------
create policy material_requests_admin on public.material_requests
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy material_requests_staff_read on public.material_requests
  for select to authenticated
  using (requester_id = public.current_staff_id() or public.is_job_member(job_id));
create policy material_requests_staff_insert on public.material_requests
  for insert to authenticated
  with check (requester_id = public.current_staff_id());
create policy material_requests_staff_update on public.material_requests
  for update to authenticated
  using (requester_id = public.current_staff_id())
  with check (requester_id = public.current_staff_id());

------------------------------------------------------------------
-- Financial records
------------------------------------------------------------------
create policy invoices_admin on public.invoices
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

create policy invoice_payments_admin on public.invoice_payments
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

create policy cash_entries_admin on public.cash_entries
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

create policy advances_admin on public.advances
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy advances_staff_read on public.advances
  for select to authenticated using (staff_id = public.current_staff_id());

create policy expenses_admin on public.expenses
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy expenses_staff_read on public.expenses
  for select to authenticated using (employee_id = public.current_staff_id());
create policy expenses_staff_insert on public.expenses
  for insert to authenticated with check (employee_id = public.current_staff_id());
create policy expenses_staff_update on public.expenses
  for update to authenticated
  using (employee_id = public.current_staff_id() and lower(status) in ('draft', 'rejected', 'submitted'))
  with check (employee_id = public.current_staff_id());

create policy salaries_admin on public.salaries
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy salaries_staff_read on public.salaries
  for select to authenticated using (staff_id = public.current_staff_id());

------------------------------------------------------------------
-- Stock movements
------------------------------------------------------------------
create policy stock_movements_admin on public.stock_movements
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy stock_movements_read on public.stock_movements
  for select to authenticated using (true);

------------------------------------------------------------------
-- Notifications
------------------------------------------------------------------
create policy notifications_admin on public.notifications
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy notifications_self_read on public.notifications
  for select to authenticated using (user_id = auth.uid());
create policy notifications_self_update on public.notifications
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

------------------------------------------------------------------
-- Settings and recycle bin
------------------------------------------------------------------
create policy settings_read on public.settings
  for select to authenticated using (true);
create policy settings_admin on public.settings
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

create policy recycle_bin_admin on public.recycle_bin
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

------------------------------------------------------------------
-- Grants
------------------------------------------------------------------
grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant execute on all functions in schema public to authenticated;

revoke all on public.document_counters from authenticated, anon;

------------------------------------------------------------------
-- Storage for receipts, photos and documents
------------------------------------------------------------------
do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public)
    values ('attachments', 'attachments', true)
    on conflict (id) do nothing;

    if not exists (
      select 1 from pg_policies
      where schemaname = 'storage' and tablename = 'objects' and policyname = 'attachments_read'
    ) then
      execute 'create policy attachments_read on storage.objects for select to authenticated using (bucket_id = ''attachments'')';
    end if;

    if not exists (
      select 1 from pg_policies
      where schemaname = 'storage' and tablename = 'objects' and policyname = 'attachments_insert'
    ) then
      execute 'create policy attachments_insert on storage.objects for insert to authenticated with check (bucket_id = ''attachments'' and (storage.foldername(name))[1] = auth.uid()::text)';
    end if;

    if not exists (
      select 1 from pg_policies
      where schemaname = 'storage' and tablename = 'objects' and policyname = 'attachments_update'
    ) then
      execute 'create policy attachments_update on storage.objects for update to authenticated using (bucket_id = ''attachments'' and owner = auth.uid()) with check (bucket_id = ''attachments'' and owner = auth.uid())';
    end if;
  end if;
end $$;
