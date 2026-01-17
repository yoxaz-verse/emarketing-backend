import { Router } from 'express';
import {
  pauseInbox,
  hardPauseInbox,
  resumeInbox,
  disableSequence,
  enableSequence,
  listOperators
} from '../services/adminService.js';
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

export default router;
