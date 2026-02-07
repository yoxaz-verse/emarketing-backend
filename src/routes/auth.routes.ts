import { Router } from 'express';
import { supabase } from '../supabase.js';
import { signToken } from '../utils/jwt.js';
import { supabaseAdmin } from '../utils/supabaseAdmin.js';
import { requireAuthLite } from '../middleware/requireAuthLite.js';
import type { Request, Response } from 'express';
import {
  requestPasswordReset,
  verifyResetOTP,
  resetPassword
} from '../services/auth/passwordReset.service';

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

router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required' });

    const result = await requestPasswordReset(email);
    return res.json(result);
  } catch (err: any) {
    console.error('FORGOT PASSWORD ERROR:', err);
    return res.status(500).json({ error: 'Failed to process request' });
  }
});

router.post('/verify-reset-otp', async (req, res) => {
  try {
    const { email, otp } = req.body;
    if (!email || !otp) return res.status(400).json({ error: 'Email and code are required' });

    const result = await verifyResetOTP(email, otp);
    return res.json(result);
  } catch (err: any) {
    console.error('VERIFY OTP ERROR:', err);
    return res.status(400).json({ error: err.message });
  }
});

router.post('/reset-password', async (req, res) => {
  try {
    const { email, new_password } = req.body;
    if (!email || !new_password) return res.status(400).json({ error: 'Email and new password are required' });

    const result = await resetPassword(email, new_password);
    return res.json(result);
  } catch (err: any) {
    console.error('RESET PASSWORD ERROR:', err);
    return res.status(400).json({ error: err.message });
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
