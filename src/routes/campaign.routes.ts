import { Router } from 'express';
import { requireAuth } from '../middleware/requireAuth';
import {
  attachLeadsToCampaign,
  detachLeadsFromCampaign,
  syncCampaignInboxes,
  startCampaign,
  pauseCampaign
} from '../services/campaign.domain';

const router = Router();
// router.use(requireAuth('operator'));


import express from 'express';
import { supabase } from '../supabase';

console.log('[ATTACH_FIX_V2] campaign routes loaded (attach uses permanently_failed, not is_blocked)');

function resolveStatusCode(err: any) {
  const statusCode = Number(err?.statusCode ?? err?.status ?? 0);
  if (Number.isInteger(statusCode) && statusCode >= 400 && statusCode < 500) {
    return statusCode;
  }
  return 500;
}

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
    res.status(resolveStatusCode(err)).json({
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
      .from('leads')
      .select('id')
      .in('folder_id', folderIds);
    if (memberError) throw memberError;
    const leadIds: string[] = Array.from(new Set((members ?? []).map((m: any) => String(m.id))));
    if (leadIds.length === 0) {
      return res.json({
        success: true,
        requested: 0,
        inserted: 0,
        detached: 0,
        skipped_existing: 0,
        skipped_ineligible: 0,
        skipped_missing: 0,
      });
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
    return res.status(resolveStatusCode(err)).json({ error: err.message ?? 'Failed to attach folder leads' });
  }
});

router.post('/:id/leads/detach', async (req, res) => {
  try {
    const campaignId = req.params.id;
    const { lead_ids } = req.body;

    if (!Array.isArray(lead_ids)) {
      return res.status(400).json({
        error: 'lead_ids must be an array',
      });
    }

    const result = await detachLeadsFromCampaign(campaignId, lead_ids);
    return res.json({
      success: true,
      ...result,
    });
  } catch (err: any) {
    console.error('[DETACH LEADS ERROR]', err);
    return res.status(resolveStatusCode(err)).json({
      error: err.message ?? 'Failed to detach leads',
    });
  }
});

// Compatibility path for clients that may include trailing slash.
router.post('/:id/leads/detach/', async (req, res) => {
  try {
    const campaignId = req.params.id;
    const { lead_ids } = req.body;

    if (!Array.isArray(lead_ids)) {
      return res.status(400).json({
        error: 'lead_ids must be an array',
      });
    }

    const result = await detachLeadsFromCampaign(campaignId, lead_ids);
    return res.json({
      success: true,
      ...result,
    });
  } catch (err: any) {
    console.error('[DETACH LEADS ERROR]', err);
    return res.status(resolveStatusCode(err)).json({
      error: err.message ?? 'Failed to detach leads',
    });
  }
});

router.post('/:id/inboxes/sync', async (req, res) => {
  try {
    const campaignId = req.params.id;
    const selectedInboxIds = Array.isArray(req.body?.selected_inbox_ids)
      ? req.body.selected_inbox_ids
      : null;

    if (!selectedInboxIds) {
      return res.status(400).json({
        error: 'selected_inbox_ids must be an array',
      });
    }

    const result = await syncCampaignInboxes(campaignId, selectedInboxIds);
    return res.json({
      success: true,
      ...result,
    });
  } catch (err: any) {
    console.error('[SYNC CAMPAIGN INBOXES ERROR]', err);
    if (err?.code === 'INBOX_LOCK_CONFLICT') {
      return res.status(409).json({
        error: err.message ?? 'Inbox lock conflict',
        code: 'INBOX_LOCK_CONFLICT',
        conflicts: Array.isArray(err?.details) ? err.details : [],
      });
    }
    return res.status(500).json({
      error: err.message ?? 'Failed to sync campaign inboxes',
    });
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
