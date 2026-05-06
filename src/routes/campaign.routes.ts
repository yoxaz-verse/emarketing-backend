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
import { supabase } from '../supabase';

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

router.post('/:id/leads/attach-folder', async (req, res) => {
  try {
    const campaignId = req.params.id;
    const folderIds = Array.isArray(req.body?.folder_ids) ? req.body.folder_ids : [];
    if (folderIds.length === 0) {
      return res.status(400).json({ error: 'folder_ids must be a non-empty array' });
    }

    const { data: members, error: memberError } = await supabase
      .from('lead_folder_memberships')
      .select('lead_id')
      .in('folder_id', folderIds);
    if (memberError) throw memberError;
    const leadIds = Array.from(new Set((members ?? []).map((m: any) => String(m.lead_id))));
    if (leadIds.length === 0) {
      return res.json({ success: true, inserted: 0 });
    }

    const result = await attachLeadsToCampaign(campaignId, leadIds);
    return res.json({
      success: true,
      ...result,
      source: 'folder_snapshot',
      folder_ids: folderIds,
    });
  } catch (err: any) {
    console.error('[ATTACH FOLDER LEADS ERROR]', err);
    return res.status(500).json({ error: err.message ?? 'Failed to attach folder leads' });
  }
});



// Campaign Step 5 , 13 here we go again
router.post('/:id/start', async (req, res) => {
  try {
    await startCampaign(req.params.id);
    res.json({ success: true });
  } catch (err: any) {
    console.error('[START CAMPAIGN ERROR]', err);
    res.status(500).json({ error: err.message ?? 'Failed to start campaign' });
  }
});

// Campaign Step 12
router.post('/:id/pause', async (req, res) => {
  try {
    await pauseCampaign(req.params.id);
    res.json({ success: true });
  } catch (err: any) {
    console.error('[PAUSE CAMPAIGN ERROR]', err);
    res.status(500).json({ error: err.message ?? 'Failed to pause campaign' });
  }
});

export default router;
