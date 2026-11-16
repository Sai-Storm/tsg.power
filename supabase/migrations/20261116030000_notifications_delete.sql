-- Allow users to permanently delete their own notifications.
-- Admins can already delete any notification through notifications_admin.

drop policy if exists notifications_self_delete on public.notifications;
create policy notifications_self_delete on public.notifications
  for delete to authenticated
  using (user_id = auth.uid());
