-- ============================================================================
-- Staff self-service advance requests
-- ============================================================================
-- Staff can submit a new advance request from the "My advances" module. The
-- request is owned by the signed-in staff member, always starts in
-- "Pending Approval", and cannot be edited by the staff member afterwards.

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

    if new.staff_id is null then
      raise exception 'Your login is not linked to a staff record. Contact an administrator.'
        using errcode = '42501';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_advances_owner on public.advances;
create trigger trg_advances_owner
  before insert on public.advances
  for each row execute function public.stamp_advance_owner();

drop policy if exists advances_staff_request on public.advances;
create policy advances_staff_request on public.advances
  for insert to authenticated
  with check (
    public.is_staff()
    and staff_id = public.current_staff_id()
    and lower(status) = 'pending approval'
  );
