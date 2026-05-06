import { Router } from 'express';
import {
  pauseInbox,
  hardPauseInbox,
  resumeInbox,
  disableSequence,
  enableSequence,
  listOperators
} from '../services/adminService.js';
import {
  getSendingLimitsConfig,
  updateSendingLimitsConfig,
} from '../services/sendingLimitsConfig.service.js';
import { requireAuth } from '../middleware/requireAuth.js';

const router = Router();

/**
 * Admin-only area
 */
router.use(requireAuth('admin'));

/**
 * Inbox controls
 */
router.post('/inbox/:id/pause', async (req, res) => {
  await pauseInbox(req.params.id, req.body?.reason);
  res.json({ success: true });
});

router.post('/inbox/:id/hard-pause', async (req, res) => {
  await hardPauseInbox(req.params.id, req.body?.reason);
  res.json({ success: true });
});

router.post('/inbox/:id/resume', async (req, res) => {
  await resumeInbox(req.params.id);
  res.json({ success: true });
});

/**
 * Sequence controls
 */
router.post('/sequence/:id/disable', async (req, res) => {
  await disableSequence(req.params.id);
  res.json({ success: true });
});

router.post('/sequence/:id/enable', async (req, res) => {
  await enableSequence(req.params.id);
  res.json({ success: true });
});

/**
 * Operators list (Admin only)
 */
router.get('/operators', async (_req, res) => {
  const { data, error } = await listOperators();

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  res.json(data);
});

router.get('/sending-limits', async (_req, res) => {
  try {
    const config = await getSendingLimitsConfig();
    res.json(config);
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? 'Failed to load sending limits' });
  }
});

router.put('/sending-limits', async (req, res) => {
  try {
    const config = await updateSendingLimitsConfig(req.body);
    res.json(config);
  } catch (err: any) {
    res.status(400).json({ error: err.message ?? 'Failed to update sending limits' });
  }
});

export default router;
