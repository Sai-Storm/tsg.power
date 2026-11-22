-- ============================================================================
-- Only accounts created by an administrator can sign in
-- ============================================================================
-- Before: anyone who signed in with Google got a Staff account automatically.
-- Now a new sign-in account is accepted only when
--   * it is the very first account (it becomes the Admin, to set up a new
--     project), or
--   * an administrator created it in Account management (the admin-users
--     function marks it with app_metadata.created_by_admin = true; only the
--     server can set app_metadata, so a visitor cannot fake it).
-- Anyone else is refused before an account exists. The sign-in page shows
-- "This email is not registered".
--
-- An admin-created person can still use "Continue with Google" with the same
-- email: Supabase links Google to the existing account, no new account is made.
--
-- Also switch off "Allow new users to sign up" in Supabase (Authentication ->
-- Sign In / Providers); this trigger is the safety net behind that setting.

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
  v_has_admin boolean;
begin
  select exists (select 1 from public.profiles where role = 'Admin') into v_has_admin;

  if v_has_admin and not coalesce((new.raw_app_meta_data->>'created_by_admin')::boolean, false) then
    raise exception 'TSG_NOT_REGISTERED: % is not registered. Ask your administrator to create your account.',
      coalesce(new.email, 'This account') using errcode = '42501';
  end if;

  v_role := case when v_has_admin then 'Staff' else 'Admin' end;

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

create or replace function public.schema_version()
returns text language sql immutable as $$ select '20261201000000'::text $$;
grant execute on function public.schema_version() to anon, authenticated;
