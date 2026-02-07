import { Router } from 'express';
import {
  getOverviewStats,
  getInboxAnalytics,
  getSequenceAnalytics,
  getNotifications
} from '../services/analyticsService.js';

import { requireAuth } from '../middleware/requireAuth.js';

const router = Router();

// router.use(requireAuth('operator'));


router.get('/overview', async (_req, res) => {
  const data = await getOverviewStats();
  res.json(data);
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
