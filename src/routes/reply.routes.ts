
import { Router } from 'express';
import { ingestInboundReply } from '../services/replyIngestService.js';

const router = Router();



// Campaign Step 15
router.post('/', async (req, res) => {
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
