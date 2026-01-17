import { Router } from 'express';
import { advanceInboxWarmup } from '../services/webhook/warmup.service';
import { handleBounce } from '../services/execution.service';
import { dailyHealthRecovery } from '../services/webhook/health.service';

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
  
  router.post('/internal/health/recover', async (_req, res) => {
    await dailyHealthRecovery();
    res.json({ success: true });
  });
  

export default router;
