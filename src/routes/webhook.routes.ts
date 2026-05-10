import { Router } from 'express';
import { advanceInboxWarmup } from '../services/webhook/warmup.service';
import { handleBounce } from '../services/execution.service';
import { dailyHealthRecovery } from '../services/webhook/health.service';
import { ingestInboundReply } from '../services/replyIngestService.js';

const router = Router();



/**
 * Warmup 
 */
router.post('/internal/warmup/advance', async (_req, res) => {
    await advanceInboxWarmup();
    res.json({ success: true });
  });
  
  
router.post('/webhooks/bounce', async (req, res) => {
    const { email, type, reason } = req.body;
  
    if (!email || !type) {
      return res.status(400).json({ error: 'Invalid payload' });
    }
  
    await handleBounce(email, type, reason);
    res.json({ success: true });
  });

router.post('/webhooks/reply', async (req, res) => {
  try {
    const result = await ingestInboundReply({
      from_email: req.body?.from_email,
      message: req.body?.message,
      inbox_email: req.body?.inbox_email,
      message_id: req.body?.message_id,
      received_at: req.body?.received_at,
      leadId: req.body?.leadId,
    });
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err?.message ?? 'Failed to ingest reply webhook' });
  }
});
  
  router.post('/internal/health/recover', async (_req, res) => {
    await dailyHealthRecovery();
    res.json({ success: true });
  });
  

export default router;
