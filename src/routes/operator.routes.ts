import { Router, Request, Response } from 'express';
import {
  uploadLeads,
  assignSequence,
  startCampaign,
  pauseCampaign,
  resumeCampaign
} from '../services/operatorService.js';
import { getCampaignStats } from '../services/operatorReadService.js';
import { getOperatorReplies } from '../services/operatorRepliesService.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { getEffectiveOperatorId } from '../utils/getEffectiveOperatorId.js';

const router = Router();

// router.use(requireAuth('operator'));

router.post('/leads/upload', async (req: Request, res: Response) => {
  const operatorId = getEffectiveOperatorId(req);
  await uploadLeads(operatorId, req.body.leads);
  res.json({ success: true });
});

// router.post('/campaign/assign-sequence', async (req, res) => {
//   const operatorId = getEffectiveOperatorId(req);
//   await assignSequence(operatorId, req.body.sequence_id);
//   res.json({ success: true });
// });

// router.post('/campaign/start', async (req, res) => {
//   const operatorId = getEffectiveOperatorId(req);
//   await startCampaign(operatorId);
//   res.json({ success: true });
// });

// router.post('/campaign/pause', async (req, res) => {
//   const operatorId = getEffectiveOperatorId(req);
//   await pauseCampaign(operatorId);
//   res.json({ success: true });
// });

// router.post('/campaign/resume', async (req, res) => {
//   const operatorId = getEffectiveOperatorId(req);
//   await resumeCampaign(operatorId);
//   res.json({ success: true });
// });

router.get('/campaign/stats', async (req, res) => {
  const operatorId = getEffectiveOperatorId(req);
  const stats = await getCampaignStats(operatorId);
  res.json(stats);
});
 
router.get('/replies', async (req, res) => {
  const operatorId = getEffectiveOperatorId(req);
  const replies = await getOperatorReplies(operatorId);
  res.json(replies);
});

export default router;


