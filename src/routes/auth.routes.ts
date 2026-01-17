import { Router } from 'express';
import { supabase } from '../supabase.js';
import { signToken } from '../utils/jwt.js';
import { supabaseAdmin } from '../utils/supabaseAdmin.js';
import { requireAuthLite } from '../middleware/requireAuthLite.js';
import type { Request, Response } from 'express';

const router = Router();

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    // 1️⃣ Authenticate via Supabase Auth
    const { data, error } = await supabaseAdmin.auth.signInWithPassword({
      email,
      password,
    });

    if (error || !data.user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const authUserId = data.user.id;

    // 2️⃣ Load app-level user
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('id, role, operator_id, active')
      .eq('auth_user_id', authUserId)
      .single();

    // 🚫 User not provisioned or disabled
    if (userError || !user || user.active !== true) {
      return res.status(401).json({ error: 'UNAUTHORIZED' });
    }

    // 3️⃣ Issue YOUR JWT
    const token = signToken({
      user_id: user.id,
      role: user.role,
      operator_id: user.operator_id,
    });

    return res.json({
      token,
      user: {
        role: user.role,
        operator_id: user.operator_id,
      },
    });
  } catch (err) {
    console.error('LOGIN ERROR:', err);
    return res.status(500).json({ error: 'Login failed' });
  }
});


export function assertAuth(
  req: Request
): asserts req is Request & {
  auth: {
    type: 'user' | 'api';
    role: any;
    user_id?: string;
    operator_id?: string | null;
    api_key_id?: string;
  };
} {
  if (!req.auth) {
    throw new Error('Auth context missing');
  }
}




router.get('/me', requireAuthLite(), async (req, res) => {
  assertAuth(req); // ✅ TS now knows req.auth exists

  const userId = req.auth.user_id;
  console.log('[GET /me] userId from token:', userId);

  if (!userId) {
    console.log('[GET /me] No userId in token');
    return res.status(401).json({ error: 'UNAUTHORIZED' });
  }

  const { data: user, error } = await supabase
    .from('users')
    .select('id, role, operator_id, active')
    .eq('id', userId)
    .single();

  if (error || !user || user.active !== true) {
    console.log('[GET /me] User lookup failed or inactive:', { error, user });
    return res.status(401).json({ error: 'UNAUTHORIZED' });
  }

  console.log('[GET /me] User found:', user.id);

  return res.json({
    id: user.id,
    role: user.role,
    operator_id: user.operator_id,
  });
});




export default router;
