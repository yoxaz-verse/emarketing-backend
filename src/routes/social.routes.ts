import { Router } from 'express';
import { requireAuth } from '../middleware/requireAuth';
import {
  createSocialPublishJobs,
  getSocialPublishJob,
  listSocialConnectors,
  retrySocialPublishJob,
} from '../services/social/social.service';

const router = Router();
router.use(requireAuth('viewer'));

router.get('/connectors', async (_req, res) => {
  try {
    const data = await listSocialConnectors();
    res.json(data);
  } catch (err: any) {
    console.error('[SOCIAL CONNECTORS ERROR]', err?.message ?? err);
    res.status(500).json({ error: err?.message ?? 'Failed to list social connectors' });
  }
});

router.post('/publish-jobs', async (req, res) => {
  try {
    const data = await createSocialPublishJobs(
      {
        idempotency_key: req.body?.idempotency_key,
        targets: req.body?.targets,
        post_input: req.body?.post_input,
      },
      req.auth?.user_id,
      req.auth?.operator_id
    );
    res.json(data);
  } catch (err: any) {
    console.error('[SOCIAL PUBLISH CREATE ERROR]', err?.message ?? err);
    res.status(400).json({ error: err?.message ?? 'Failed to create social publish jobs' });
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
