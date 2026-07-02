
import { Router } from 'express';
import { ingestInboundReply } from '../services/replyIngestService.js';
import { rateLimit, requireWebhookSignature } from '../middleware/security';

const router = Router();



// Campaign Step 15
router.post('/', rateLimit({ name: 'reply-webhook', windowMs: 60_000, max: 120 }), requireWebhookSignature(), async (req, res) => {
    const result = await ingestInboundReply({
      from_email: req.body?.from_email ?? req.body?.from,
      message: req.body?.message,
      inbox_email: req.body?.inbox_email,
      message_id: req.body?.message_id,
      received_at: req.body?.received_at,
      leadId: req.body?.leadId,
      source: 'manual_api',
    });
    res.json(result);
  });
  

export default router;
