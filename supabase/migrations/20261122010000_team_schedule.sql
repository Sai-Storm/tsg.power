-- ============================================================================
-- Team schedule (shared availability calendar)
-- ============================================================================
-- Admin and Staff both need to see who is busy on which day so jobs can be
-- planned without negotiating availability. Staff RLS only exposes jobs they
-- work on, so this security-definer RPC returns a minimal, read-only view of
-- every active staff member and the jobs they are assigned to within a date
-- range (job number, title, customer, status, dates and assigned staff ids).
--
-- A job occupies its staff from
--   coalesce(planned_start_date, site_visit_date, job_date)
-- to
--   coalesce(planned_end_date, <start>)
-- Cancelled and deleted jobs are excluded.
--
-- Idempotent: safe to run more than once.

create or replace function public.team_schedule(p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not (public.is_admin() or public.is_staff()) then
    raise exception 'Not authorized to view the team schedule' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 62 then
    raise exception 'Choose a date range of up to 62 days';
  end if;

  return jsonb_build_object(
    'staff', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', s.id,
        'name', s.name,
        'designation', s.designation
      ) order by s.name)
      from public.staff s
      where s.deleted_at is null
        and lower(coalesce(s.status, 'active')) = 'active'
    ), '[]'::jsonb),

    'me', coalesce((
      select jsonb_agg(t.id) from public.my_staff_ids() as t(id)
    ), '[]'::jsonb),

    'jobs', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', x.id,
        'number', x.number,
        'title', x.title,
        'customer', x.customer,
        'status', x.status,
        'start_date', x.start_date,
        'end_date', x.end_date,
        'staff_ids', x.staff_ids
      ) order by x.start_date, x.number)
      from (
        select
          j.id,
          j.number,
          j.title,
          c.name as customer,
          j.status,
          coalesce(j.planned_start_date, j.site_visit_date, j.job_date) as start_date,
          greatest(
            coalesce(j.planned_end_date, j.planned_start_date, j.site_visit_date, j.job_date),
            coalesce(j.planned_start_date, j.site_visit_date, j.job_date)
          ) as end_date,
          coalesce((
            select jsonb_agg(distinct u.staff_id)
            from (
              select j.assigned_to::text as staff_id
              union all
              select j.team_leader::text
              union all
              select case jsonb_typeof(e.value)
                       when 'object' then coalesce(e.value->>'id', e.value->>'staff_id')
                       else e.value #>> '{}'
                     end
              from jsonb_array_elements(
                case when jsonb_typeof(j.assigned_employees) = 'array' then j.assigned_employees else '[]'::jsonb end
              ) e
            ) u
            where coalesce(u.staff_id, '') <> ''
          ), '[]'::jsonb) as staff_ids
        from public.jobs j
        left join public.customers c on c.id = j.customer_id
        where j.deleted_at is null
          and lower(coalesce(j.status, '')) <> 'cancelled'
      ) x
      where x.start_date is not null
        and x.start_date <= p_to
        and x.end_date >= p_from
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.team_schedule(date, date) from public;
grant execute on function public.team_schedule(date, date) to authenticated;
