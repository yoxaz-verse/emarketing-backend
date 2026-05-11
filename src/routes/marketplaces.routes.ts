import { Router } from 'express';
import { requireAuth } from '../middleware/requireAuth';
import {
  createPublishJobs,
  getPublishJob,
  listConnectors,
  retryPublishJob,
} from '../services/marketplaces/marketplaces.service';

const router = Router();
router.use(requireAuth('viewer'));

router.get('/connectors', async (_req, res) => {
  try {
    const data = await listConnectors();
    res.json(data);
  } catch (err: any) {
    console.error('[MARKETPLACE CONNECTORS ERROR]', err?.message ?? err);
    res.status(500).json({ error: err?.message ?? 'Failed to list marketplace connectors' });
  }
});

router.post('/publish-jobs', async (req, res) => {
  try {
    const data = await createPublishJobs(
      {
        idempotency_key: req.body?.idempotency_key,
        targets: req.body?.targets,
        listing_input: req.body?.listing_input,
      },
      req.auth?.user_id,
      req.auth?.operator_id
    );
    res.json(data);
  } catch (err: any) {
    console.error('[MARKETPLACE PUBLISH CREATE ERROR]', err?.message ?? err);
    res.status(400).json({ error: err?.message ?? 'Failed to create publish jobs' });
  }
});

router.get('/publish-jobs/:id', async (req, res) => {
  try {
    const data = await getPublishJob(req.params.id);
    res.json(data);
  } catch (err: any) {
    console.error('[MARKETPLACE PUBLISH READ ERROR]', err?.message ?? err);
    res.status(404).json({ error: err?.message ?? 'Publish job not found' });
  }
});

router.post('/publish-jobs/:id/retry', async (req, res) => {
  try {
    const data = await retryPublishJob(req.params.id);
    res.json(data);
  } catch (err: any) {
    console.error('[MARKETPLACE PUBLISH RETRY ERROR]', err?.message ?? err);
    res.status(400).json({ error: err?.message ?? 'Retry failed' });
  }
});

export default router;
