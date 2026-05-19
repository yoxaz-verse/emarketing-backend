import { Router } from 'express';
import {
  getOverviewStats,
  getInboxAnalytics,
  getSequenceAnalytics,
  getNotifications
} from '../services/analyticsService.js';
import { getOperationsSummary } from '../services/dashboardSummary.service.js';

import { requireAuth } from '../middleware/requireAuth.js';

const router = Router();

router.use(requireAuth('viewer'));


router.get('/overview', async (_req, res) => {
  const data = await getOverviewStats();
  res.json(data);
});

router.get('/operations-summary', async (req, res) => {
  const startedAt = Date.now();
  try {
    const data = await getOperationsSummary(req.auth);
    console.info('[STATS_OPERATIONS_SUMMARY_OK]', {
      durationMs: Date.now() - startedAt,
    });
    res.json(data);
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : typeof error === 'object' && error !== null && 'message' in error
          ? String((error as { message?: unknown }).message ?? 'Unknown error')
          : String(error ?? 'Unknown error');
    console.error('[STATS_OPERATIONS_SUMMARY_ERROR]', {
      durationMs: Date.now() - startedAt,
      message,
      error,
    });
    res.status(500).json({
      error: 'Failed to load operations summary',
      detail: message,
    });
  }
});

router.get('/inboxes', async (_req, res) => {
  const data = await getInboxAnalytics();
  res.json(data);
});

router.get('/sequences', async (_req, res) => {
  const data = await getSequenceAnalytics();
  res.json(data);
});


router.get('/notifications', async (_req, res) => {
  const data = await getNotifications();
  res.json(data);
});

export default router;
