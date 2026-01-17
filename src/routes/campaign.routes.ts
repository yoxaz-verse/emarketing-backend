import { Router } from 'express';
import { requireAuth } from '../middleware/requireAuth';
import {
  attachLeadsToCampaign,
  startCampaign,
  pauseCampaign
} from '../services/campaign.domain';

const router = Router();
// router.use(requireAuth('operator'));


import express from 'express';

router.post('/:id/leads/attach', async (req, res) => {
  try {
    const campaignId = req.params.id;
    const { lead_ids } = req.body;

    if (!Array.isArray(lead_ids)) {
      return res.status(400).json({
        error: 'lead_ids must be an array',
      });
    }

    const result = await attachLeadsToCampaign(
      campaignId,
      lead_ids
    );

    res.json({
      success: true,
      ...result,
    });
  } catch (err: any) {
    console.error('[ATTACH LEADS ERROR]', err);
    res.status(500).json({
      error: err.message ?? 'Failed to attach leads',
    });
  }
});



// Campaign Step 5 , 13 here we go again
router.post('/:id/start', async (req, res) => {
  await startCampaign(req.params.id);
  res.json({ success: true });
});

// Campaign Step 12
router.post('/:id/pause', async (req, res) => {
  await pauseCampaign(req.params.id);
  res.json({ success: true });
});

export default router;
