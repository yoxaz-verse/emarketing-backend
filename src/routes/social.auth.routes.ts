import { Router } from 'express';
import { requireAuth } from '../middleware/requireAuth';
import { requireWriteRole } from '../middleware/security';
import {
  disconnectPlatform,
  getConnectionStatuses,
  handlePlatformCallback,
  startPlatformConnect,
} from '../services/social/socialAuth.service';
import {
  classifySocialOAuthError,
  socialOAuthErrorUrl,
  socialOAuthSuccessUrl,
} from '../services/social/oauthRedirect';

const router = Router();

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

async function handleCallback(req: any, res: any, platformInput?: string) {
  try {
    const platform = String(platformInput ?? req.params?.platform ?? req.query?.platform ?? 'linkedin');
    const result = await handlePlatformCallback({
      platform,
      code: String(req.query?.code ?? ''),
      state: String(req.query?.state ?? ''),
    });

    res.redirect(socialOAuthSuccessUrl(platform, process.env, { operatorId: result.context.operatorId }));
  } catch (err: any) {
    const message = err?.message ?? 'connect_failed';
    const operatorId = String(err?.socialOAuthContext?.operatorId ?? '').trim();
    console.error('[SOCIAL CONNECT CALLBACK ERROR]', message);
    res.redirect(socialOAuthErrorUrl(message, process.env, classifySocialOAuthError(message), { operatorId }));
  }
}

router.get('/callback/:platform', async (req, res) => {
  return handleCallback(req, res, String(req.params.platform ?? ''));
});

// Compatibility callback path for existing LinkedIn app redirects.
// Accepts ?platform=...; defaults to linkedin for current production setup.
router.get('/oauth2-credential/callback', async (req, res) => {
  return handleCallback(req, res, String(req.query?.platform ?? 'linkedin'));
});

router.use(requireAuth('viewer'));
router.use(requireWriteRole);

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
  try {
    const operatorId = resolveOperatorId(req);
    if (!operatorId) {
      return res.redirect(socialOAuthErrorUrl('operator_id is required for admin action'));
    }
    const authUrl = await startPlatformConnect(req.params.platform, req.auth?.user_id, operatorId);
    res.redirect(authUrl);
  } catch (err: any) {
    const message = err?.message ?? 'Failed to start social connect flow';
    console.error('[SOCIAL CONNECT START ERROR]', message);
    res.redirect(socialOAuthErrorUrl(message, process.env, classifySocialOAuthError(message)));
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
