import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!supabaseUrl || !anonKey || !serviceKey) return json({ error: 'Supabase environment is incomplete' }, 500);

    const authHeader = req.headers.get('Authorization') ?? '';
    const caller = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { data: userData, error: userError } = await caller.auth.getUser();
    if (userError || !userData.user) return json({ error: 'Not authenticated' }, 401);

    const admin = createClient(supabaseUrl, serviceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { data: profile, error: profileError } = await admin
      .from('profiles')
      .select('id, role, is_active')
      .eq('id', userData.user.id)
      .single();

    if (profileError || !profile) return json({ error: 'Profile not found' }, 404);
    if (String(profile.role).toLowerCase() !== 'admin' || !profile.is_active) {
      return json({ error: 'Admin access required' }, 403);
    }

    const body = await req.json().catch(() => ({}));
    const action = String(body.action ?? 'create');

    if (action === 'create') {
      const email = String(body.email ?? '').trim().toLowerCase();
      const password = String(body.password ?? '');
      const name = String(body.name ?? '').trim();
      const role = String(body.role ?? 'Staff') === 'Admin' ? 'Admin' : 'Staff';
      const avatar = body.avatar ? String(body.avatar) : null;
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: 'A valid email address is required' }, 400);
      if (password.length < 8) return json({ error: 'Password must be at least 8 characters' }, 400);
      if (!name) return json({ error: 'Full name is required' }, 400);

      let username = String(body.username ?? email.split('@')[0])
        .toLowerCase()
        .replace(/[^a-z0-9._-]/g, '')
        .slice(0, 40) || 'user';
      const { data: existing } = await admin.from('profiles').select('id').eq('username', username).maybeSingle();
      if (existing) username = `${username}_${crypto.randomUUID().slice(0, 4)}`;

      const { data: created, error: createError } = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { full_name: name, avatar_url: avatar },
      });
      if (createError) return json({ error: createError.message }, 409);
      if (!created.user) return json({ error: 'User was not created' }, 500);

      const { data: updated, error: updateError } = await admin
        .from('profiles')
        .update({ name, username, role, avatar })
        .eq('id', created.user.id)
        .select()
        .single();
      if (updateError) return json({ error: updateError.message }, 500);

      return json({ user: updated });
    }

    if (action === 'reset-password') {
      const userId = String(body.user_id ?? '');
      const password = String(body.password ?? '');
      if (!userId) return json({ error: 'user_id is required' }, 400);
      if (password.length < 8) return json({ error: 'Password must be at least 8 characters' }, 400);
      const { error } = await admin.auth.admin.updateUserById(userId, { password });
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }

    if (action === 'set-active') {
      const userId = String(body.user_id ?? '');
      const active = Boolean(body.is_active);
      if (!userId) return json({ error: 'user_id is required' }, 400);
      if (userId === userData.user.id && !active) return json({ error: 'You cannot deactivate your own account' }, 400);
      const { data: updated, error } = await admin
        .from('profiles')
        .update({ is_active: active })
        .eq('id', userId)
        .select()
        .single();
      if (error) return json({ error: error.message }, 400);
      await admin.auth.admin.updateUserById(userId, { ban_duration: active ? 'none' : '876000h' }).catch(() => undefined);
      return json({ user: updated });
    }

    if (action === 'set-role') {
      const userId = String(body.user_id ?? '');
      const role = String(body.role ?? '') === 'Admin' ? 'Admin' : 'Staff';
      if (!userId) return json({ error: 'user_id is required' }, 400);
      if (userId === userData.user.id && role !== 'Admin') return json({ error: 'You cannot remove your own admin role' }, 400);
      const { data: updated, error } = await admin.from('profiles').update({ role }).eq('id', userId).select().single();
      if (error) return json({ error: error.message }, 400);
      return json({ user: updated });
    }

    return json({ error: 'Unknown action' }, 400);
  } catch (error) {
    return json({ error: message(error) }, 500);
  }
});
