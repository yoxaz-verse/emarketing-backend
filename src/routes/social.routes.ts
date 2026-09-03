import { Router } from 'express';
import { requireAuth } from '../middleware/requireAuth';
import { requireWriteRole } from '../middleware/security';
import { requireModuleAccess } from '../auth/moduleAccess';
import {
  createSocialPublishJobs,
  getSocialPublishJob,
  listSocialPublishJobs,
  processDueSocialPublishJobs,
  listSocialConnectors,
  optimizeSocialPublishInput,
  retrySocialPublishJob,
  SocialTargetReadinessError,
  updateSocialPublishRequestJobs,
} from '../services/social/social.service';
import {
  enableSocialAutomation,
  getSocialSetupStatus,
  saveMetaAccountSelection,
  saveOperatorSocialCredentials,
  startSocialSetupConnect,
} from '../services/social/socialSetup.service';

const router = Router();
router.use(requireAuth('viewer'));
router.use(requireModuleAccess('social_media'));
router.use(requireWriteRole);

function resolveOperatorId(req: any): string | null {
  const role = String(req.auth?.role ?? '').toLowerCase();
  if (role === 'admin' || role === 'superadmin') {
    const fromQuery = String(req.query?.operator_id ?? '').trim();
    const fromBody = String(req.body?.operator_id ?? '').trim();
    return fromQuery || fromBody || null;
  }
  return req.auth?.operator_id ?? null;
}

router.get('/connectors', async (req, res) => {
  try {
    const operatorId = resolveOperatorId(req);
    const data = await listSocialConnectors(req.auth?.user_id, operatorId);
    res.json(data);
  } catch (err: any) {
    console.error('[SOCIAL CONNECTORS ERROR]', err?.message ?? err);
    res.status(500).json({ error: err?.message ?? 'Failed to list social connectors' });
  }
});

router.get('/setup/status', async (req, res) => {
  try {
    const operatorId = resolveOperatorId(req);
    const role = String(req.auth?.role ?? '').toLowerCase();
    if ((role === 'admin' || role === 'superadmin') && !operatorId) {
      return res.json(await getSocialSetupStatus(req.auth?.user_id, null));
    }
    const data = await getSocialSetupStatus(req.auth?.user_id, operatorId);
    res.json(data);
  } catch (err: any) {
    console.error('[SOCIAL SETUP STATUS ERROR]', err?.message ?? err);
    res.status(500).json({ error: err?.message ?? 'Failed to read social setup status' });
  }
});

router.post('/setup/credentials', async (req, res) => {
  try {
    const operatorId = resolveOperatorId(req);
    const data = await saveOperatorSocialCredentials({
      platform: req.body?.platform,
      operatorId,
      input: req.body?.fields ?? req.body ?? {},
    });
    res.json(data);
  } catch (err: any) {
    console.error('[SOCIAL SETUP CREDENTIALS ERROR]', err?.message ?? err);
    const statusCode = Number(err?.statusCode ?? 400);
    res.status(statusCode >= 400 && statusCode < 600 ? statusCode : 400).json({
      error: err?.message ?? 'Failed to save social credentials',
      details: err?.details,
    });
  }
});

router.post('/setup/start', async (req, res) => {
  try {
    const operatorId = resolveOperatorId(req);
    const data = await startSocialSetupConnect({
      platform: req.body?.platform,
      userId: req.auth?.user_id,
      operatorId,
    });
    res.json(data);
  } catch (err: any) {
    console.error('[SOCIAL SETUP START ERROR]', err?.message ?? err);
    const statusCode = Number(err?.statusCode ?? 400);
    res.status(statusCode >= 400 && statusCode < 600 ? statusCode : 400).json({
      error: err?.message ?? 'Failed to start social setup',
      details: err?.details,
    });
  }
});

router.post('/setup/account-selection', async (req, res) => {
  try {
    const operatorId = resolveOperatorId(req);
    const data = await saveMetaAccountSelection({
      userId: req.auth?.user_id,
      operatorId,
      pageId: req.body?.selected_page_id,
      instagramAccountId: req.body?.selected_instagram_account_id,
    });
    res.json(data);
  } catch (err: any) {
    console.error('[SOCIAL SETUP ACCOUNT SELECTION ERROR]', err?.message ?? err);
    res.status(400).json({ error: err?.message ?? 'Failed to save social account selection' });
  }
});

router.post('/setup/automation', async (req, res) => {
  try {
    const operatorId = resolveOperatorId(req);
    const data = await enableSocialAutomation({
      userId: req.auth?.user_id,
      operatorId,
      timezone: req.body?.timezone,
    });
    res.json(data);
  } catch (err: any) {
    console.error('[SOCIAL SETUP AUTOMATION ERROR]', err?.message ?? err);
    res.status(400).json({ error: err?.message ?? 'Failed to enable social automation' });
  }
});

router.post('/optimize', async (req, res) => {
  try {
    const operatorId = resolveOperatorId(req);
    const role = String(req.auth?.role ?? '').toLowerCase();
    if ((role === 'admin' || role === 'superadmin') && !operatorId) {
      return res.status(400).json({ error: 'operator_id is required for admin optimization' });
    }
    const data = await optimizeSocialPublishInput(
      {
        targets: req.body?.targets,
        post_input: req.body?.post_input,
        idempotency_key: req.body?.idempotency_key,
      },
      req.auth?.user_id,
      operatorId
    );
    res.json(data);
  } catch (err: any) {
    console.error('[SOCIAL OPTIMIZE ERROR]', err?.message ?? err);
    res.status(400).json({ error: err?.message ?? 'Failed to optimize social post' });
  }
});

router.post('/publish-jobs', async (req, res) => {
  try {
    const operatorId = resolveOperatorId(req);
    const role = String(req.auth?.role ?? '').toLowerCase();
    if ((role === 'admin' || role === 'superadmin') && !operatorId) {
      return res.status(400).json({ error: 'operator_id is required for admin scheduling' });
    }
    const data = await createSocialPublishJobs(
      {
        idempotency_key: req.body?.idempotency_key,
        targets: req.body?.targets,
        post_input: req.body?.post_input,
      },
      req.auth?.user_id,
      operatorId
    );
    res.json(data);
  } catch (err: any) {
    console.error('[SOCIAL PUBLISH CREATE ERROR]', err?.message ?? err);
    if (err instanceof SocialTargetReadinessError) {
      return res.status(err.status).json({ error: err.message, code: err.code, details: err.details });
    }
    res.status(400).json({ error: err?.message ?? 'Failed to create social publish jobs' });
  }
});

router.get('/publish-jobs', async (req, res) => {
  try {
    const operatorId = resolveOperatorId(req);
    const data = await listSocialPublishJobs({
      userId: req.auth?.user_id,
      operatorId,
      role: req.auth?.role,
      limit: Number(req.query?.limit ?? 200),
    });
    res.json(data);
  } catch (err: any) {
    console.error('[SOCIAL PUBLISH LIST ERROR]', err?.message ?? err);
    res.status(500).json({ error: err?.message ?? 'Failed to list social publish jobs' });
  }
});

router.post('/publish-jobs/process-due', async (req, res) => {
  try {
    const role = String(req.auth?.role ?? '').toLowerCase();
    if (role !== 'admin' && role !== 'superadmin') {
      return res.status(403).json({ error: 'Only admin can process due social publish jobs manually' });
    }
    const data = await processDueSocialPublishJobs(Number(req.body?.limit ?? 25));
    res.json(data);
  } catch (err: any) {
    console.error('[SOCIAL PUBLISH PROCESS_DUE ERROR]', err?.message ?? err);
    res.status(400).json({ error: err?.message ?? 'Failed to process due social publish jobs' });
  }
});

router.get('/publish-jobs/:id', async (req, res) => {
  try {
    const data = await getSocialPublishJob(req.params.id);
    res.json(data);
  } catch (err: any) {
    console.error('[SOCIAL PUBLISH READ ERROR]', err?.message ?? err);
    res.status(404).json({ error: err?.message ?? 'Social publish job not found' });
  }
});

router.patch('/publish-requests/:id', async (req, res) => {
  try {
    const operatorId = resolveOperatorId(req);
    const role = String(req.auth?.role ?? '').toLowerCase();
    if ((role === 'admin' || role === 'superadmin') && !operatorId) {
      return res.status(400).json({ error: 'operator_id is required for admin scheduling' });
    }
    const data = await updateSocialPublishRequestJobs({
      requestId: req.params.id,
      input: {
        idempotency_key: req.body?.idempotency_key,
        targets: req.body?.targets,
        post_input: req.body?.post_input,
      },
      userId: req.auth?.user_id,
      operatorId,
      role: req.auth?.role,
    });
    res.json(data);
  } catch (err: any) {
    console.error('[SOCIAL PUBLISH UPDATE ERROR]', err?.message ?? err);
    if (err instanceof SocialTargetReadinessError) {
      return res.status(err.status).json({ error: err.message, code: err.code, details: err.details });
    }
    res.status(400).json({ error: err?.message ?? 'Failed to update social publish jobs' });
  }
});

router.post('/publish-jobs/:id/retry', async (req, res) => {
  try {
    const data = await retrySocialPublishJob(req.params.id);
    res.json(data);
  } catch (err: any) {
    console.error('[SOCIAL PUBLISH RETRY ERROR]', err?.message ?? err);
    res.status(400).json({ error: err?.message ?? 'Retry failed' });
  }
});

export default router;
