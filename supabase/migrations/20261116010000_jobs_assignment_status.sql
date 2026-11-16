-- ============================================================================
-- Job status follows assignment
-- ============================================================================
-- A job that has a team leader / assigned technician should no longer stay in
-- Draft. When such a job is created or saved from the create/edit form, move
-- it to Scheduled (when planned dates exist) or Assigned. The assign_job RPC
-- already performs this transition; this trigger covers plain inserts and
-- updates that bypass the RPC.
--
-- Idempotent: safe to run more than once.

create or replace function public.sync_job_assignment_status()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if lower(coalesce(new.status, '')) in ('draft', 'new')
     and (new.assigned_to is not null or new.team_leader is not null) then
    new.status := case
      when new.planned_start_date is not null or new.planned_end_date is not null then 'Scheduled'
      else 'Assigned'
    end;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_jobs_assignment_status on public.jobs;
create trigger trg_jobs_assignment_status
  before insert or update of status, assigned_to, team_leader, planned_start_date, planned_end_date
  on public.jobs
  for each row execute function public.sync_job_assignment_status();

-- Backfill jobs that were created before this trigger existed.
update public.jobs
set status = case
  when planned_start_date is not null or planned_end_date is not null then 'Scheduled'
  else 'Assigned'
end
where deleted_at is null
  and lower(coalesce(status, '')) in ('draft', 'new')
  and (assigned_to is not null or team_leader is not null);
