-- Staff can create job orders, but after insert PostgREST returns the new row
-- (INSERT ... RETURNING), which PostgreSQL filters through the SELECT policy.
-- Without read access to their own record the insert fails with
-- "new row violates row-level security policy for table jobs".
-- Let staff read and update the jobs they created, and keep the insert policy
-- permissive for every signed-in user.

drop policy if exists jobs_staff_read on public.jobs;
create policy jobs_staff_read on public.jobs
  for select to authenticated
  using (public.is_job_member(id) or created_by = auth.uid());

drop policy if exists jobs_staff_insert on public.jobs;
create policy jobs_staff_insert on public.jobs
  for insert to authenticated
  with check (true);

drop policy if exists jobs_staff_update on public.jobs;
create policy jobs_staff_update on public.jobs
  for update to authenticated
  using (public.is_job_member(id) or created_by = auth.uid())
  with check (public.is_job_member(id) or created_by = auth.uid());
