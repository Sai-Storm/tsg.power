import { supabase, requireSupabase } from './supabase.js';

export function toAppUser(profile, authUser) {
  const metadata = authUser?.user_metadata || {};
  const email = authUser?.email || profile?.email || '';
  const fallbackName = metadata.full_name || metadata.name || email.split('@')[0] || 'User';
  return {
    id: profile?.id || authUser?.id,
    name: profile?.name || fallbackName,
    username: profile?.username || email.split('@')[0] || 'user',
    role: String(profile?.role || 'Staff').toLowerCase() === 'admin' ? 'Admin' : 'Staff',
    avatar: profile?.avatar || metadata.avatar_url || '',
    email,
  };
}

export async function loadProfile(authUser) {
  if (!authUser) return null;
  const client = requireSupabase();
  const { data, error } = await client
    .from('profiles')
    .select('id,name,username,role,avatar,email,is_active')
    .eq('id', authUser.id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (data && data.is_active === false) {
    await client.auth.signOut();
    throw new Error('This account has been deactivated. Contact an administrator.');
  }
  return toAppUser(data || {}, authUser);
}

export async function getCurrentUser() {
  const client = requireSupabase();
  const { data, error } = await client.auth.getSession();
  if (error) throw new Error(error.message);
  if (!data.session?.user) return null;
  return loadProfile(data.session.user);
}

export async function signInWithGoogle(redirectTo = window.location.origin) {
  const client = requireSupabase();
  const { error } = await client.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo,
      queryParams: { prompt: 'select_account' },
    },
  });
  if (error) throw new Error(error.message);
}

export async function signInWithPassword(email, password) {
  const client = requireSupabase();
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw new Error(error.message);
  return loadProfile(data.user);
}

export async function signOut() {
  if (!supabase) return;
  await supabase.auth.signOut();
}

export async function updatePassword(password) {
  const client = requireSupabase();
  const { error } = await client.auth.updateUser({ password });
  if (error) throw new Error(error.message);
}

export function onAuthStateChange(callback) {
  if (!supabase) return { unsubscribe: () => {} };
  const { data } = supabase.auth.onAuthStateChange((event, session) => {
    if (event === 'SIGNED_OUT' || !session?.user) {
      callback(null, event);
      return;
    }
    setTimeout(() => {
      loadProfile(session.user)
        .then(user => callback(user, event))
        .catch(() => callback(null, event));
    }, 0);
  });
  return { unsubscribe: () => data.subscription.unsubscribe() };
}
