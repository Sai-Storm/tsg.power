
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json',
    },
  });
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function isValidEmail(email: string) {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

    if (!supabaseUrl || !anonKey || !serviceKey) {
      return json(
        { error: 'Supabase environment is incomplete' },
        500
      );
    }

    // Verify the requesting user's access token.
    const authHeader = req.headers.get('Authorization') ?? '';

    if (!authHeader.startsWith('Bearer ')) {
      return json({ error: 'Authentication required' }, 401);
    }

    const caller = createClient(supabaseUrl, anonKey, {
      global: {
        headers: { Authorization: authHeader },
      },
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    });

    const {
      data: userData,
      error: userError,
    } = await caller.auth.getUser();

    if (userError || !userData.user) {
      return json({ error: 'Not authenticated' }, 401);
    }

    // Admin client: server-side operations only.
    const admin = createClient(supabaseUrl, serviceKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    });

    // Verify the caller's Admin role using the database.
    const {
      data: profile,
      error: profileError,
    } = await admin
      .from('profiles')
      .select('id, role, is_active')
      .eq('id', userData.user.id)
      .single();

    if (profileError || !profile) {
      return json({ error: 'Profile not found' }, 404);
    }

    if (
      String(profile.role).toLowerCase() !== 'admin' ||
      profile.is_active !== true
    ) {
      return json({ error: 'Admin access required' }, 403);
    }

    const body = await req.json().catch(() => null);

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return json({ error: 'Invalid request body' }, 400);
    }

    const action = String(body.action ?? 'create');

    // -----------------------------------------
    // ACTION 1: CREATE USER
    // -----------------------------------------

    if (action === 'create') {
      const email = String(body.email ?? '').trim().toLowerCase();
      const password = String(body.password ?? '');
      const name = String(body.name ?? '').trim();

      const requestedRole = String(body.role ?? 'Staff');

      const role =
        requestedRole.toLowerCase() === 'admin'
          ? 'Admin'
          : requestedRole.toLowerCase() === 'staff'
            ? 'Staff'
            : null;

      const avatar = body.avatar
        ? String(body.avatar)
        : null;

      if (!isValidEmail(email)) {
        return json({ error: 'A valid email address is required' }, 400);
      }

      if (password.length < 8) {
        return json(
          { error: 'Password must be at least 8 characters' },
          400
        );
      }

      if (!name) {
        return json({ error: 'Full name is required' }, 400);
      }

      if (!role) {
        return json({ error: 'Invalid user role' }, 400);
      }

      let username = String(
        body.username ?? email.split('@')[0]
      )
        .toLowerCase()
        .replace(/[^a-z0-9._-]/g, '')
        .slice(0, 40) || 'user';

      const { data: existing, error: usernameError } = await admin
        .from('profiles')
        .select('id')
        .eq('username', username)
        .maybeSingle();

      if (usernameError) {
        return json({ error: usernameError.message }, 500);
      }

      if (existing) {
        username = `${username}_${crypto.randomUUID().slice(0, 4)}`;
      }

      const {
        data: created,
        error: createError,
      } = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: {
          full_name: name,
          avatar_url: avatar,
        },
      });

      if (createError) {
        return json({ error: createError.message }, 409);
      }

      if (!created.user) {
        return json({ error: 'User was not created' }, 500);
      }

      // This assumes a database trigger creates the profile
      // when a new auth.users record is inserted.
      const {
        data: updated,
        error: updateError,
      } = await admin
        .from('profiles')
        .update({
          name,
          username,
          role,
          avatar,
        })
        .eq('id', created.user.id)
        .select()
        .single();

      if (updateError || !updated) {
        // Avoid leaving an Auth user without a valid profile.
        const { error: deleteError } =
          await admin.auth.admin.deleteUser(created.user.id);

        if (deleteError) {
          return json({
            error: 'Profile creation failed and user cleanup failed. Contact an administrator.',
          }, 500);
        }

        return json({
          error: updateError?.message ?? 'Profile update failed',
        }, 500);
      }

      return json({ user: updated }, 201);
    }

    // -----------------------------------------
    // ACTION 2: RESET PASSWORD
    // -----------------------------------------

    if (action === 'reset-password') {
      const userId = String(body.user_id ?? '');
      const password = String(body.password ?? '');

      if (!userId) {
        return json({ error: 'user_id is required' }, 400);
      }

      if (password.length < 8) {
        return json(
          { error: 'Password must be at least 8 characters' },
          400
        );
      }

      const { error } = await admin.auth.admin.updateUserById(
        userId,
        { password }
      );

      if (error) {
        return json({ error: error.message }, 400);
      }

      return json({ ok: true });
    }

    // -----------------------------------------
    // ACTION 3: ACTIVATE / DEACTIVATE USER
    // -----------------------------------------

    if (action === 'set-active') {
      const userId = String(body.user_id ?? '');

      if (!userId) {
        return json({ error: 'user_id is required' }, 400);
      }

      if (typeof body.is_active !== 'boolean') {
        return json(
          { error: 'is_active must be a boolean' },
          400
        );
      }

      const active = body.is_active;

      if (userId === userData.user.id && !active) {
        return json(
          { error: 'You cannot deactivate your own account' },
          400
        );
      }

      if (!active) {
        const { data: target } = await admin
          .from('profiles')
          .select('id, role, is_active')
          .eq('id', userId)
          .maybeSingle();

        if (!target) {
          return json({ error: 'User not found' }, 404);
        }

        if (
          String(target.role).toLowerCase() === 'admin' &&
          target.is_active
        ) {
          const { count, error: countError } = await admin
            .from('profiles')
            .select('id', { count: 'exact', head: true })
            .eq('role', target.role)
            .eq('is_active', true);

          if (countError) {
            return json({ error: countError.message }, 500);
          }

          if ((count ?? 0) <= 1) {
            return json(
              { error: 'Cannot deactivate the last active Admin' },
              400
            );
          }
        }
      }

      const { data: updated, error } = await admin
        .from('profiles')
        .update({ is_active: active })
        .eq('id', userId)
        .select()
        .single();

      if (error || !updated) {
        return json(
          { error: error?.message ?? 'User not found' },
          400
        );
      }

      // Apply or remove an Auth ban.
      const { error: banError } =
        await admin.auth.admin.updateUserById(userId, {
          ban_duration: active ? 'none' : '876000h',
        });

      if (banError) {
        // Restore the previous profile status if banning fails.
        await admin
          .from('profiles')
          .update({ is_active: !active })
          .eq('id', userId);

        return json({ error: banError.message }, 500);
      }

      return json({ user: updated });
    }

    // -----------------------------------------
    // ACTION 4: CHANGE USER ROLE
    // -----------------------------------------

    if (action === 'set-role') {
      const userId = String(body.user_id ?? '');
      const requestedRole = String(body.role ?? '');

      const role =
        requestedRole.toLowerCase() === 'admin'
          ? 'Admin'
          : requestedRole.toLowerCase() === 'staff'
            ? 'Staff'
            : null;

      if (!userId) {
        return json({ error: 'user_id is required' }, 400);
      }

      if (!role) {
        return json({ error: 'Invalid user role' }, 400);
      }

      if (
        userId === userData.user.id &&
        role !== 'Admin'
      ) {
        return json(
          { error: 'You cannot remove your own admin role' },
          400
        );
      }

      if (role === 'Staff') {
        const { data: target } = await admin
          .from('profiles')
          .select('id, role, is_active')
          .eq('id', userId)
          .maybeSingle();

        if (!target) {
          return json({ error: 'User not found' }, 404);
        }

        if (
          String(target.role).toLowerCase() === 'admin' &&
          target.is_active
        ) {
          const { count, error: countError } = await admin
            .from('profiles')
            .select('id', { count: 'exact', head: true })
            .eq('role', target.role)
            .eq('is_active', true);

          if (countError) {
            return json({ error: countError.message }, 500);
          }

          if ((count ?? 0) <= 1) {
            return json(
              { error: 'Cannot demote the last active Admin' },
              400
            );
          }
        }
      }

      const { data: updated, error } = await admin
        .from('profiles')
        .update({ role })
        .eq('id', userId)
        .select()
        .single();

      if (error || !updated) {
        return json(
          { error: error?.message ?? 'User not found' },
          400
        );
      }

      return json({ user: updated });
    }

    return json({ error: 'Unknown action' }, 400);

  } catch (error) {
    // Avoid returning internal stack traces or secrets.
    console.error('admin-users error:', error);

    return json(
      { error: 'An unexpected server error occurred' },
      500
    );
  }
});
