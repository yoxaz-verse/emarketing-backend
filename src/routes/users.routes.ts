import { Router } from 'express';
import { supabaseAdmin } from '../utils/supabaseAdmin.js';
import { supabase } from '../supabase.js';

const router = Router();



/**
 * BOOTSTRAP ADMIN CREATION (ONE-TIME)
 */
router.post('/bootstrap', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    const { count } = await supabase
      .from('users')
      .select('id', { count: 'exact', head: true });

    if (count && count > 0) {
      return res.status(403).json({ error: 'Bootstrap already completed' });
    }

    const { data: authData, error: authError } =
      await supabaseAdmin.auth.admin.createUser({
        email,
        password,
        email_confirm: true
      });

    if (authError || !authData.user) {
      return res.status(400).json({
        error: authError?.message || 'Auth user creation failed'
      });
    }

    const authUserId = authData.user.id;

    const { error: userError } = await supabase
      .from('users')
      .insert({
        auth_user_id: authUserId,
        email: email.toLowerCase(),
        role: 'superadmin',
        operator_id: null,
        active: true
      });

    if (userError) {
      await supabaseAdmin.auth.admin.deleteUser(authUserId);
      return res.status(400).json({ error: userError.message });
    }

    return res.json({
      success: true,
      message: 'Superadmin created. Bootstrap complete.'
    });

  } catch (err) {
    console.error('BOOTSTRAP ERROR:', err);
    return res.status(500).json({ error: 'Bootstrap failed' });
  }
});



export default router;
