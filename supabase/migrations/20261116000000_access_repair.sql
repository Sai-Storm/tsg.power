-- ============================================================================
-- TSG Power ERP - full access / RLS repair
-- ============================================================================
-- Idempotent reconciliation script. Safe to run more than once.
-- Paste into Supabase Dashboard -> SQL Editor and run.
--
-- What it fixes:
--   1. Staff accounts get a linked public.staff row automatically, so
--      current_staff_id() is no longer NULL (this was breaking inserts into
--      jobs, material_requests, expenses, service_reports, salaries, ...).
--   2. Rebuilds every public RLS policy from scratch, including the
--      "staff created this record" visibility that was missing for jobs,
--      service reports and material requests.
--   3. Customers can be managed by Admin or Staff (no more Admin lockout).
--   4. Re-grants table/function privileges and keeps document_counters locked.
-- ============================================================================

--------------------------------------------------------------------------
-- 0. Role helpers (re-created so this script works on any DB state)
--------------------------------------------------------------------------
create or replace function public.is_admin()
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and lower(p.role) = 'admin' and p.is_active
  );
$$;

create or replace function public.is_staff()
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and lower(p.role) = 'staff' and p.is_active
  );
$$;

create or replace function public.current_staff_id()
returns uuid
language plpgsql
stable security definer set search_path = public
as $$
declare
  v_id uuid;
begin
  select s.id into v_id
  from public.staff s
  where s.profile_id = auth.uid() and s.deleted_at is null
  limit 1;
  if v_id is not null then
    return v_id;
  end if;

  -- Fallback for older staff rows that were created from Staff management
  -- before the profile was linked: match the account by email, then name.
  select s.id into v_id
  from public.staff s
  join public.profiles p on p.id = auth.uid()
  where s.deleted_at is null
    and s.profile_id is null
    and (
      (lower(coalesce(p.email, '')) <> '' and lower(coalesce(s.email, '')) = lower(p.email))
      or lower(trim(coalesce(s.name, ''))) = lower(trim(coalesce(p.name, '')))
    )
  order by (lower(coalesce(s.email, '')) = lower(coalesce(p.email, ''))) desc, s.created_at
  limit 1;

  return v_id;
end;
$$;

create or replace function public.is_job_member(p_job uuid)
returns boolean
language sql stable security definer set search_path = public
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

--------------------------------------------------------------------------
-- 1. Keep public.staff in sync with public.profiles
--------------------------------------------------------------------------
create or replace function public.sync_staff_from_profile()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if lower(coalesce(new.role, '')) = 'staff' then
    -- Already linked to a staff record?
    if exists (select 1 from public.staff y where y.profile_id = new.id) then
      return new;
    end if;

    -- 1) Link an existing unlinked staff row by email.
    update public.staff s
    set profile_id = new.id,
        email = coalesce(nullif(s.email, ''), new.email)
    where s.id = (
      select x.id from public.staff x
      where x.profile_id is null
        and x.deleted_at is null
        and lower(coalesce(new.email, '')) <> ''
        and lower(coalesce(x.email, '')) = lower(coalesce(new.email, ''))
      order by x.created_at
      limit 1
    );

    -- 2) Otherwise link by name, but only when the match is unambiguous.
    --    Manual staff records created from Staff management have no email,
    --    so without this every new account would duplicate its staff row.
    if not found then
      update public.staff s
      set profile_id = new.id,
          email = coalesce(nullif(s.email, ''), new.email)
      where s.id = (
        select x.id from public.staff x
        where x.profile_id is null
          and x.deleted_at is null
          and lower(trim(coalesce(new.name, ''))) <> ''
          and lower(trim(x.name)) = lower(trim(new.name))
          and (
            select count(*) from public.staff y
            where y.profile_id is null
              and y.deleted_at is null
              and lower(trim(y.name)) = lower(trim(new.name))
          ) = 1
        order by x.created_at
        limit 1
      );
    end if;

    -- 3) Fall back to creating a new staff record.
    if not found then
      insert into public.staff (name, phone, email, designation, status, profile_id)
      values (
        coalesce(nullif(new.name, ''), nullif(new.username, ''), split_part(coalesce(new.email, ''), '@', 1), 'Staff'),
        null,
        new.email,
        null,
        'Active',
        new.id
      )
      on conflict (profile_id) do nothing;
    end if;
  elsif tg_op = 'UPDATE' then
    if lower(coalesce(old.role, '')) = 'staff'
       and lower(coalesce(new.role, '')) <> 'staff' then
      -- Moved away from Staff (e.g. promoted to Admin): drop the auto-created
      -- staff row only when nothing references it, so history stays intact.
      delete from public.staff s
      where s.profile_id = new.id
        and not exists (select 1 from public.jobs j
          where j.assigned_to = s.id or j.team_leader = s.id
             or coalesce(j.assigned_employees, '[]'::jsonb) ? (s.id::text))
        and not exists (select 1 from public.expenses e where e.employee_id = s.id)
        and not exists (select 1 from public.advances a where a.staff_id = s.id)
        and not exists (select 1 from public.salaries sal where sal.staff_id = s.id)
        and not exists (select 1 from public.fixed_assets fa where fa.assigned_to = s.id);
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_profiles_sync_staff on public.profiles;
create trigger trg_profiles_sync_staff
  after insert or update of role, name, email, is_active on public.profiles
  for each row execute function public.sync_staff_from_profile();

-- Backfill: link existing staff rows to profiles by email.
update public.staff s
set profile_id = p.id
from public.profiles p
where s.profile_id is null
  and s.deleted_at is null
  and lower(coalesce(p.role, '')) = 'staff'
  and lower(coalesce(s.email, '')) = lower(coalesce(p.email, ''))
  and not exists (select 1 from public.staff x where x.profile_id = p.id);

-- Backfill: create staff rows for active Staff profiles that still have none.
insert into public.staff (name, phone, email, designation, status, profile_id)
select
  coalesce(nullif(p.name, ''), nullif(p.username, ''), split_part(coalesce(p.email, ''), '@', 1), 'Staff'),
  null,
  p.email,
  null,
  'Active',
  p.id
from public.profiles p
where lower(coalesce(p.role, '')) = 'staff'
  and p.is_active
  and not exists (select 1 from public.staff s where s.profile_id = p.id);

-- Backfill: merge duplicate staff rows (same name, only one linked to an
-- account). References are moved to the surviving row, then the duplicate is
-- soft-deleted so it disappears from every lookup.
do $$
declare
  g record;
  v_keeper uuid;
  v_dup record;
begin
  for g in
    select lower(trim(name)) as name_key
    from public.staff
    where deleted_at is null
    group by 1
    having count(*) > 1 and count(profile_id) = 1
  loop
    select id into v_keeper
    from public.staff
    where deleted_at is null and lower(trim(name)) = g.name_key
    order by (profile_id is not null) desc, created_at asc
    limit 1;

    for v_dup in
      select id from public.staff
      where deleted_at is null and lower(trim(name)) = g.name_key and id <> v_keeper
    loop
      update public.staff k
      set phone = coalesce(k.phone, d.phone),
          designation = coalesce(k.designation, d.designation),
          join_date = coalesce(k.join_date, d.join_date),
          salary = coalesce(k.salary, d.salary)
      from public.staff d
      where k.id = v_keeper and d.id = v_dup.id;

      update public.jobs set assigned_to = v_keeper where assigned_to = v_dup.id;
      update public.jobs set team_leader = v_keeper where team_leader = v_dup.id;
      update public.jobs j
      set assigned_employees = (
        select coalesce(jsonb_agg(distinct entry), '[]'::jsonb)
        from (
          select case
            when jsonb_typeof(e) = 'string' and e #>> '{}' = v_dup.id::text
              then to_jsonb(v_keeper::text)
            else e
          end as entry
          from jsonb_array_elements(j.assigned_employees) e
        ) x
      )
      where j.assigned_employees @> to_jsonb(v_dup.id::text);

      update public.material_requests set requester_id = v_keeper where requester_id = v_dup.id;
      update public.expenses set employee_id = v_keeper where employee_id = v_dup.id;
      update public.advances set staff_id = v_keeper where staff_id = v_dup.id;
      update public.salaries set staff_id = v_keeper where staff_id = v_dup.id;
      update public.fixed_assets set assigned_to = v_keeper where assigned_to = v_dup.id;

      update public.staff set deleted_at = now() where id = v_dup.id;
    end loop;
  end loop;
end $$;

--------------------------------------------------------------------------
-- 1b. Ensure ownership stamping triggers exist
--------------------------------------------------------------------------
create or replace function public.stamp_created_by()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  if new.created_by is null then
    new.created_by := auth.uid();
  end if;
  return new;
end;
$$;

create or replace function public.stamp_expense_owner()
returns trigger language plpgsql security definer set search_path = public
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
returns trigger language plpgsql security definer set search_path = public
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
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  new.submitted_by := auth.uid();
  return new;
end;
$$;

drop trigger if exists trg_expenses_owner on public.expenses;
create trigger trg_expenses_owner before insert on public.expenses
  for each row execute function public.stamp_expense_owner();

drop trigger if exists trg_material_requests_owner on public.material_requests;
create trigger trg_material_requests_owner before insert on public.material_requests
  for each row execute function public.stamp_request_owner();

drop trigger if exists trg_service_reports_owner on public.service_reports;
create trigger trg_service_reports_owner before insert on public.service_reports
  for each row execute function public.stamp_service_report_owner();

do $$
declare t text;
begin
  foreach t in array array[
    'customers','suppliers','machines','inventory_items','fixed_assets',
    'quotations','jobs','invoices','advances','cash_entries','salaries'
  ]
  loop
    execute format('drop trigger if exists trg_%s_created_by on public.%I', t, t);
    execute format(
      'create trigger trg_%s_created_by before insert on public.%I for each row execute function public.stamp_created_by()',
      t, t
    );
  end loop;
end $$;

--------------------------------------------------------------------------
-- 1c. Defensive NOT NULL numeric defaults
--     The UI can send an explicit NULL for optional amount fields, which
--     overrides the column default and fails the NOT NULL constraint.
--     These triggers keep the last value on update and use 0 on insert.
--------------------------------------------------------------------------
create or replace function public.normalize_job_numbers()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    new.job_amount := coalesce(new.job_amount, 0);
    new.additional_charges := coalesce(new.additional_charges, 0);
  else
    new.job_amount := coalesce(new.job_amount, old.job_amount);
    new.additional_charges := coalesce(new.additional_charges, old.additional_charges);
  end if;
  return new;
end;
$$;

create or replace function public.normalize_quotation_numbers()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    new.subtotal := coalesce(new.subtotal, 0);
    new.tax := coalesce(new.tax, 0);
    new.total := coalesce(new.total, 0);
  else
    new.subtotal := coalesce(new.subtotal, old.subtotal);
    new.tax := coalesce(new.tax, old.tax);
    new.total := coalesce(new.total, old.total);
  end if;
  return new;
end;
$$;

create or replace function public.normalize_invoice_numbers()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    new.subtotal := coalesce(new.subtotal, 0);
    new.tax := coalesce(new.tax, 0);
    new.additional_charges := coalesce(new.additional_charges, 0);
    new.discount := coalesce(new.discount, 0);
    new.total := coalesce(new.total, 0);
    new.amount_received := coalesce(new.amount_received, 0);
  else
    new.subtotal := coalesce(new.subtotal, old.subtotal);
    new.tax := coalesce(new.tax, old.tax);
    new.additional_charges := coalesce(new.additional_charges, old.additional_charges);
    new.discount := coalesce(new.discount, old.discount);
    new.total := coalesce(new.total, old.total);
    new.amount_received := coalesce(new.amount_received, old.amount_received);
  end if;
  return new;
end;
$$;

create or replace function public.normalize_salary_numbers()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    new.basic_salary := coalesce(new.basic_salary, 0);
    new.allowances := coalesce(new.allowances, 0);
    new.deductions := coalesce(new.deductions, 0);
  else
    new.basic_salary := coalesce(new.basic_salary, old.basic_salary);
    new.allowances := coalesce(new.allowances, old.allowances);
    new.deductions := coalesce(new.deductions, old.deductions);
  end if;
  return new;
end;
$$;

drop trigger if exists trg_jobs_numeric_defaults on public.jobs;
create trigger trg_jobs_numeric_defaults
  before insert or update on public.jobs
  for each row execute function public.normalize_job_numbers();

drop trigger if exists trg_quotations_numeric_defaults on public.quotations;
create trigger trg_quotations_numeric_defaults
  before insert or update on public.quotations
  for each row execute function public.normalize_quotation_numbers();

drop trigger if exists trg_invoices_numeric_defaults on public.invoices;
create trigger trg_invoices_numeric_defaults
  before insert or update on public.invoices
  for each row execute function public.normalize_invoice_numbers();

drop trigger if exists trg_salaries_numeric_defaults on public.salaries;
create trigger trg_salaries_numeric_defaults
  before insert or update on public.salaries
  for each row execute function public.normalize_salary_numbers();

--------------------------------------------------------------------------
-- 2. Rebuild every public policy
--------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'profiles','staff','customers','suppliers','machines','inventory_items',
    'fixed_assets','quotations','jobs','service_reports','material_requests',
    'invoices','invoice_payments','advances','expenses','cash_entries',
    'salaries','stock_movements','notifications','settings','recycle_bin'
  ]
  loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;

do $$
declare
  r record;
begin
  for r in
    select policyname, tablename
    from pg_policies
    where schemaname = 'public'
      and tablename = any (array[
        'profiles','staff','customers','suppliers','machines','inventory_items',
        'fixed_assets','quotations','jobs','service_reports','material_requests',
        'invoices','invoice_payments','advances','expenses','cash_entries',
        'salaries','stock_movements','notifications','settings','recycle_bin'
      ])
  loop
    execute format('drop policy %I on public.%I', r.policyname, r.tablename);
  end loop;
end $$;

-- Profiles ------------------------------------------------------------------
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

-- Master data ---------------------------------------------------------------
create policy customers_read on public.customers
  for select to authenticated using (true);
create policy customers_write on public.customers
  for all to authenticated
  using (public.is_admin() or public.is_staff())
  with check (public.is_admin() or public.is_staff());

create policy suppliers_read on public.suppliers
  for select to authenticated using (true);
create policy suppliers_admin on public.suppliers
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

create policy machines_read on public.machines
  for select to authenticated using (true);
create policy machines_admin on public.machines
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

create policy inventory_read on public.inventory_items
  for select to authenticated using (true);
create policy inventory_admin on public.inventory_items
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

create policy fixed_assets_read on public.fixed_assets
  for select to authenticated using (true);
create policy fixed_assets_admin on public.fixed_assets
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

create policy staff_read on public.staff
  for select to authenticated using (true);
create policy staff_admin on public.staff
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

create policy quotations_read on public.quotations
  for select to authenticated using (true);
create policy quotations_admin on public.quotations
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- Jobs ----------------------------------------------------------------------
create policy jobs_admin on public.jobs
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy jobs_staff_read on public.jobs
  for select to authenticated
  using (public.is_job_member(id) or created_by = auth.uid());
create policy jobs_staff_insert on public.jobs
  for insert to authenticated
  with check (public.is_admin() or public.is_staff());
create policy jobs_staff_update on public.jobs
  for update to authenticated
  using (public.is_job_member(id) or created_by = auth.uid())
  with check (public.is_job_member(id) or created_by = auth.uid());

-- Service reports -----------------------------------------------------------
create policy service_reports_admin on public.service_reports
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy service_reports_staff_read on public.service_reports
  for select to authenticated
  using (
    submitted_by = auth.uid()
    or public.is_job_member(job_id)
    or exists (select 1 from public.jobs j where j.id = job_id and j.created_by = auth.uid())
  );
create policy service_reports_staff_insert on public.service_reports
  for insert to authenticated
  with check (
    submitted_by = auth.uid()
    and (
      public.is_job_member(job_id)
      or exists (select 1 from public.jobs j where j.id = job_id and j.created_by = auth.uid())
    )
  );
create policy service_reports_staff_update on public.service_reports
  for update to authenticated
  using (
    submitted_by = auth.uid()
    or exists (select 1 from public.jobs j where j.id = job_id and j.created_by = auth.uid())
  )
  with check (submitted_by = auth.uid());

-- Material requests ---------------------------------------------------------
create policy material_requests_admin on public.material_requests
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy material_requests_staff_read on public.material_requests
  for select to authenticated
  using (
    requester_id = public.current_staff_id()
    or created_by = auth.uid()
    or public.is_job_member(job_id)
    or exists (select 1 from public.jobs j where j.id = job_id and j.created_by = auth.uid())
  );
create policy material_requests_staff_insert on public.material_requests
  for insert to authenticated
  with check (created_by = auth.uid());
create policy material_requests_staff_update on public.material_requests
  for update to authenticated
  using (
    requester_id = public.current_staff_id()
    or created_by = auth.uid()
    or exists (select 1 from public.jobs j where j.id = job_id and j.created_by = auth.uid())
  )
  with check (created_by = auth.uid());

-- Financial records ---------------------------------------------------------
create policy invoices_admin on public.invoices
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy invoice_payments_admin on public.invoice_payments
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy cash_entries_admin on public.cash_entries
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

create policy advances_admin on public.advances
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy advances_staff_read on public.advances
  for select to authenticated
  using (staff_id = public.current_staff_id() or created_by = auth.uid());

create policy expenses_admin on public.expenses
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy expenses_staff_read on public.expenses
  for select to authenticated
  using (employee_id = public.current_staff_id() or created_by = auth.uid());
create policy expenses_staff_insert on public.expenses
  for insert to authenticated
  with check (created_by = auth.uid());
create policy expenses_staff_update on public.expenses
  for update to authenticated
  using (employee_id = public.current_staff_id() or created_by = auth.uid())
  with check (employee_id = public.current_staff_id() or created_by = auth.uid());

create policy salaries_admin on public.salaries
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy salaries_staff_read on public.salaries
  for select to authenticated
  using (staff_id = public.current_staff_id());

-- Stock movements -----------------------------------------------------------
create policy stock_movements_read on public.stock_movements
  for select to authenticated using (true);
create policy stock_movements_admin on public.stock_movements
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- Notifications -------------------------------------------------------------
create policy notifications_admin on public.notifications
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy notifications_self_read on public.notifications
  for select to authenticated using (user_id = auth.uid());
create policy notifications_self_update on public.notifications
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- Settings / recycle bin ----------------------------------------------------
create policy settings_read on public.settings
  for select to authenticated using (true);
create policy settings_admin on public.settings
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy recycle_bin_admin on public.recycle_bin
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

--------------------------------------------------------------------------
-- 3. Privileges
--------------------------------------------------------------------------
grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant execute on all functions in schema public to authenticated;

-- Document counters are only touched by SECURITY DEFINER functions.
revoke all on public.document_counters from authenticated, anon;

--------------------------------------------------------------------------
-- 4. Storage (idempotent)
--------------------------------------------------------------------------
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

-- ============================================================================
-- Verification queries (run these manually after the script succeeds):
--
--   select tablename, policyname, cmd from pg_policies
--   where schemaname = 'public' order by tablename, policyname;
--
--   select p.email, p.role, p.is_active, s.id as staff_id, s.name
--   from public.profiles p
--   left join public.staff s on s.profile_id = p.id
--   order by p.created_at;
-- ============================================================================
