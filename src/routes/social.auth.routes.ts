import { Router } from 'express';
import { requireAuth } from '../middleware/requireAuth';
import {
  disconnectPlatform,
  getConnectionStatuses,
  handlePlatformCallback,
  startPlatformConnect,
} from '../services/social/socialAuth.service';

const router = Router();
router.use(requireAuth('viewer'));

function resolveOperatorId(req: any): string | null {
  const role = String(req.auth?.role ?? '').toLowerCase();
  if (role === 'admin' || role === 'superadmin') {
    const fromQuery = String(req.query?.operator_id ?? '').trim();
    const fromBody = String(req.body?.operator_id ?? '').trim();
    const operatorId = fromQuery || fromBody;
    return operatorId || null;
  }
  return req.auth?.operator_id ?? null;
}

function socialRedirectBase() {
  return process.env.SOCIAL_OAUTH_SUCCESS_REDIRECT || 'http://localhost:3000/dashboard/social-connectors';
}

router.get('/connections', async (req, res) => {
  try {
    const operatorId = resolveOperatorId(req);
    const data = await getConnectionStatuses(req.auth?.user_id, operatorId);
    res.json(data);
  } catch (err: any) {
    console.error('[SOCIAL CONNECTION LIST ERROR]', err?.message ?? err);
    res.status(500).json({ error: err?.message ?? 'Failed to list social connections' });
  }
});

router.get('/connect/:platform', async (req, res) => {
  const frontend = socialRedirectBase();
  try {
    const operatorId = resolveOperatorId(req);
    if (!operatorId) {
      const message = encodeURIComponent('operator_id is required for admin action');
      return res.redirect(`${frontend}?social_connect_error=${message}`);
    }
    const authUrl = await startPlatformConnect(req.params.platform, req.auth?.user_id, operatorId);
    res.redirect(authUrl);
  } catch (err: any) {
    console.error('[SOCIAL CONNECT START ERROR]', err?.message ?? err);
    const message = encodeURIComponent(err?.message ?? 'Failed to start social connect flow');
    res.redirect(`${frontend}?social_connect_error=${message}`);
  }
});

router.get('/callback/:platform', async (req, res) => {
  const frontend = socialRedirectBase();
  try {
    await handlePlatformCallback({
      platform: req.params.platform,
      code: String(req.query?.code ?? ''),
      state: String(req.query?.state ?? ''),
    });

    res.redirect(`${frontend}?social_connected=${encodeURIComponent(req.params.platform)}`);
  } catch (err: any) {
    console.error('[SOCIAL CONNECT CALLBACK ERROR]', err?.message ?? err);
    const message = encodeURIComponent(err?.message ?? 'connect_failed');
    res.redirect(`${frontend}?social_connect_error=${message}`);
  }
});

router.post('/disconnect/:platform', async (req, res) => {
  try {
    const operatorId = resolveOperatorId(req);
    const data = await disconnectPlatform(req.params.platform, req.auth?.user_id, operatorId);
    res.json(data);
  } catch (err: any) {
    console.error('[SOCIAL DISCONNECT ERROR]', err?.message ?? err);
    res.status(400).json({ error: err?.message ?? 'Failed to disconnect social platform' });
  }
});

export default router;
