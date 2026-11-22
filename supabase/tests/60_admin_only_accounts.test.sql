-- ============================================================================
-- Only accounts created by an administrator are accepted.
-- Runs after 10_ - 50_ (an Admin already exists).
-- ============================================================================

select tests.throws('a stranger signing in with Google gets no account',
  $q$insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
     values ('00000000-0000-0000-0000-00000000cc01', 'stranger@gmail.com', '{"full_name":"Stranger"}', '{"provider":"google"}')$q$,
  'not registered');
select tests.ok('the stranger has no profile',
  not exists (select 1 from public.profiles where email = 'stranger@gmail.com'));

select tests.throws('a visitor cannot sign up with email and password either',
  $q$insert into auth.users (id, email, raw_user_meta_data)
     values ('00000000-0000-0000-0000-00000000cc02', 'visitor@example.com', '{}')$q$,
  'not registered');

insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
values ('00000000-0000-0000-0000-00000000cc03', 'newhire@tsg.local', '{"full_name":"New Hire"}', '{"provider":"email","created_by_admin":true}');
select tests.eq('an account created by the administrator is accepted as Staff',
  (select role from public.profiles where id = '00000000-0000-0000-0000-00000000cc03'), 'Staff');
