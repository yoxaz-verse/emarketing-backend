import { Role, ROLE_HIERARCHY } from '../../auth/roles';
import { supabase } from '../../supabase';
import { supabaseAdmin } from '../../utils/supabaseAdmin';

function isValidRole(role: any): role is Role {
  return role in ROLE_HIERARCHY;
}

export async function handleUserBeforeWrite(
  payload: Record<string, any>,
  mode: 'create' | 'update'
) {
  // DEBUG: proves independent executions
  console.log('REQUEST ID:', crypto.randomUUID());
  console.log('ENTRY payload:', structuredClone(payload));

  /* ======================================================
     1️⃣ VALIDATION + NORMALIZATION
  ====================================================== */
  if (!payload.email) {
    throw new Error('Email is required');
  }

  payload.email = payload.email.toLowerCase();

  if (!isValidRole(payload.role)) {
    throw new Error('Invalid role');
  }

  /* ======================================================
     2️⃣ AUTH USER RESOLUTION (CREATE MODE ONLY)
     AUTH IS SOURCE OF TRUTH FOR users.id
  ====================================================== */
  if (mode === 'create') {
    // 🚫 NEVER trust inbound id during create
    delete payload.id;

    // 🚫 REMOVED listUsers check (it returns admin by default in some client versions/configs)
    // Create new auth user directly
    const incomingPassword = typeof payload.password === 'string' ? payload.password.trim() : '';
    if (!incomingPassword) {
      throw new Error(
        'Password is required when creating users. Set a password so the user can sign in via email/password.'
      );
    }

    const { data, error } =
      await supabaseAdmin.auth.admin.createUser({
        email: payload.email,
        password: incomingPassword,
        email_confirm: true,
      });

    if (error || !data?.user?.id) {
      console.error('[USER_CREATE_AUTH_FAILED]', {
        email: payload.email,
        reason: error?.message ?? 'unknown_error',
      });
      throw error ?? new Error('Failed to create auth user');
    }
    payload.auth_user_id = data.user.id;
  }

  /* ======================================================
     3️⃣ OPERATOR CAPABILITY
     (OPERATOR IS NOT A ROLE)
  ====================================================== */
  const wantsOperator = payload.is_operator === true;

  if (wantsOperator) {
    if (!payload.operator_id) {
      const { data: operator, error } = await supabase
        .from('operators')
        .insert({
          name: payload.email,
          status: 'active',
        })
        .select('id')
        .single();

      if (error) throw error;
      payload.operator_id = operator.id;
    }
  }

  /* ======================================================
     4️⃣ CLEAN PAYLOAD
     (ONLY MUTATION, NO DB WRITE)
  ====================================================== */
  delete payload.is_operator;
  delete payload.password;

  console.log('FINAL payload:', payload);

  // IMPORTANT:
  // Do NOT insert into users table here.
  // Central CRUD will perform exactly one write.

  return payload;
}

export async function handleUserBeforeDelete(userId: string) {
  const { data: user, error } = await supabase
    .from('users')
    .select('operator_id')
    .eq('id', userId)
    .maybeSingle();

  if (error) throw error;

  if (user?.operator_id) {
    await supabase
      .from('operators')
      .delete()
      .eq('id', user.operator_id);
  }
}
