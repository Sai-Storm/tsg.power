-- ============================================================================
-- Staff profile self-service
-- ============================================================================
-- Staff can edit their own name, phone, username, password and profile picture
-- through public.profiles (already allowed by the profiles_update policy).
-- Administrators can edit any staff member's profile from Staff management.
--
-- This migration:
--   1. Prevents non-admins from changing their own role or account status.
--   2. Keeps the linked public.staff row in sync when profile name/phone change.
--   3. Exposes phone on v_profiles so the accounts screen can read it.

------------------------------------------------------------------
-- 1. Guard against self-service privilege escalation
------------------------------------------------------------------
create or replace function public.guard_profile_self_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is not null and auth.uid() = new.id and not public.is_admin() then
    if new.role is distinct from old.role then
      raise exception 'Only an administrator can change account roles.' using errcode = '42501';
    end if;
    if new.is_active is distinct from old.is_active then
      raise exception 'Only an administrator can change account status.' using errcode = '42501';
    end if;
    if new.email is distinct from old.email then
      raise exception 'Only an administrator can change the login email.' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_profiles_guard_self_update on public.profiles;
create trigger trg_profiles_guard_self_update
  before update on public.profiles
  for each row execute function public.guard_profile_self_update();

------------------------------------------------------------------
-- 2. Keep staff record in sync with the linked profile
------------------------------------------------------------------
create or replace function public.sync_staff_from_profile()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if lower(coalesce(new.role, '')) = 'staff' then
    -- Update the linked staff row with personal details edited on the profile.
    update public.staff s
    set name = coalesce(nullif(new.name, ''), s.name),
        phone = coalesce(new.phone, s.phone)
    where s.profile_id = new.id
      and s.deleted_at is null;

    if found then
      return new;
    end if;

    -- No linked row yet: try to link an existing unlinked staff row by email.
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

    -- Otherwise link by name, but only when the match is unambiguous.
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

    -- Fall back to creating a new staff record.
    if not found then
      insert into public.staff (name, phone, email, designation, status, profile_id)
      values (
        coalesce(nullif(new.name, ''), nullif(new.username, ''), split_part(coalesce(new.email, ''), '@', 1), 'Staff'),
        new.phone,
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
  after insert or update of role, name, email, phone, is_active on public.profiles
  for each row execute function public.sync_staff_from_profile();

------------------------------------------------------------------
-- 3. Expose phone on the account view
------------------------------------------------------------------
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
  p.updated_at,
  p.phone
from public.profiles p;
