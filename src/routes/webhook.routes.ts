import { Router } from 'express';
import { advanceInboxWarmup } from '../services/webhook/warmup.service';
import { handleBounce } from '../services/execution.service';
import { dailyHealthRecovery } from '../services/webhook/health.service';
import { ingestInboundReply } from '../services/replyIngestService.js';
import { ingestPixelOpenEvent, ingestProviderEmailEvent } from '../services/emailTracking.service.js';

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

router.post('/webhooks/email-event', async (req, res) => {
  try {
    const result = await ingestProviderEmailEvent(req.body ?? {});
    if (result.success === false) {
      return res.status(400).json(result);
    }
    if (result.event_type === 'bounced_hard' || result.event_type === 'bounced_soft') {
      const bounceEmail = String(result.to_email ?? '').trim().toLowerCase();
      if (bounceEmail) {
        await handleBounce(
          bounceEmail,
          result.event_type === 'bounced_hard' ? 'hard' : 'soft',
          String((req.body as any)?.reason ?? '')
        );
      }
    }
    return res.json(result);
  } catch (err: any) {
    return res.status(400).json({ error: err?.message ?? 'Failed to ingest provider email event' });
  }
});

router.get('/tracking/open/:token', async (req, res) => {
  try {
    await ingestPixelOpenEvent(String(req.params.token ?? ''));
  } catch (err: any) {
    console.warn('[PIXEL_OPEN_TRACKING_WARN]', err?.message ?? err);
  }

  const pixel = Buffer.from('R0lGODlhAQABAPAAAAAAAAAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==', 'base64');
  res.setHeader('Content-Type', 'image/gif');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  return res.status(200).send(pixel);
});
  
  router.post('/internal/health/recover', async (_req, res) => {
    await dailyHealthRecovery();
    res.json({ success: true });
  });
  

export default router;
