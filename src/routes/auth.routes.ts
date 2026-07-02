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
import { rateLimit } from '../middleware/security';

const router = Router();

router.post('/login', rateLimit({ name: 'login', windowMs: 15 * 60_000, max: 10 }), async (req, res) => {
  try {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required', code: 'MISSING_CREDENTIALS' });
    }

    // 1️⃣ Authenticate via Supabase Auth
    const { data, error } = await supabaseAdmin.auth.signInWithPassword({
      email,
      password,
    });

    if (error || !data.user) {
      console.warn('[AUTH_LOGIN_INVALID_CREDENTIALS]', {
        email,
        code: error?.code ?? 'unknown',
        message: error?.message ?? 'unknown',
        status: error?.status ?? null,
      });
      return res.status(401).json({ error: 'Invalid credentials', code: 'INVALID_CREDENTIALS' });
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
      console.warn('[AUTH_LOGIN_UNAUTHORIZED_USER]', {
        email,
        authUserId,
        hasUser: Boolean(user),
        active: user?.active ?? null,
        dbError: userError?.message ?? null,
      });
      return res.status(401).json({ error: 'UNAUTHORIZED', code: 'UNAUTHORIZED_USER' });
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
  } catch (err: any) {
    console.error('[AUTH_LOGIN_ERROR]', {
      message: err?.message ?? 'unknown',
      stack: err?.stack ?? null,
    });
    return res.status(500).json({ error: 'Login failed', code: 'LOGIN_INTERNAL_ERROR' });
  }
});

router.post('/forgot-password', rateLimit({ name: 'forgot-password', windowMs: 15 * 60_000, max: 5 }), async (req, res) => {
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

router.post('/verify-reset-otp', rateLimit({ name: 'verify-reset', windowMs: 15 * 60_000, max: 10 }), async (req, res) => {
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

router.post('/reset-password', rateLimit({ name: 'reset-password', windowMs: 15 * 60_000, max: 5 }), async (req, res) => {
  try {
    const { email, new_password, reset_token } = req.body;
    if (!email || !new_password || !reset_token) return res.status(400).json({ error: 'Email, new password, and reset authorization are required' });

    const result = await resetPassword(email, new_password, reset_token);
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
  if (!userId) {
    return res.status(401).json({ error: 'UNAUTHORIZED' });
  }

  const { data: user, error } = await supabase
    .from('users')
    .select('id, role, operator_id, email, active')
    .eq('id', userId)
    .single();

  if (error || !user || user.active !== true) {
    return res.status(401).json({ error: 'UNAUTHORIZED' });
  }

  return res.json({
    id: user.id,
    role: user.role,
    operator_id: user.operator_id,
    email: user.email,
  });
});




export default router;
