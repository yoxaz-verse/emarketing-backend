import { Router } from 'express';
import { requireAuth } from '../middleware/requireAuth';
import {

  handleBounce,
  completeCampaignIfDone,
  getNextCampaignExecutions,
  sendCampaignEmail,
  markCampaignLeadSent,
  resetInboxCounters,
  markCampaignLeadFailed,
} from '../services/execution.service';
import { supabase } from '../supabase';
import { handleReply } from '../services/replyIngestService';

const router = Router();

// router.use(requireAuth('operator'));


// Campaign Step 6
// Campaign Step 6 (CORRECTED)
router.get('/campaigns/:id/next-executions', async (req, res) => {
  try {
    const { id: campaignId } = req.params;
    const batchSize = Number(req.query.batch_size ?? 10);

    const executions = await getNextCampaignExecutions(
      campaignId,
      batchSize
    );

    res.json({ executions });
  } catch (err: any) {
    console.error('[NEXT EXECUTIONS ERROR]', err);
    res.status(400).json({ error: err.message });
  }
});

// Campaign Phase 7 — Send Email (BACKEND ONLY)
router.post('/send-email', async (req, res) => {
  try {
    const { campaign_lead_id } = req.body;

    if (!campaign_lead_id) {
      return res.status(400).json({ error: 'campaign_lead_id is required' });
    }

    const result = await sendCampaignEmail(campaign_lead_id);

    res.json({ success: true, result });
  } catch (err: any) {
    console.error('[SEND EMAIL ERROR]', err);
    res.status(400).json({ error: err.message });
  }
});

/** * STEP SUCCESS */

// Campaign Step 8 - Sucess Sent
router.post('/campaign-leads/:id/sent', async (req, res) => {
  try {
    const { id } = req.params;

    await markCampaignLeadSent(id);

    res.json({ success: true });
  } catch (err: any) {
    console.error('[MARK SENT ERROR]', err);
    res.status(400).json({ error: err.message });
  }
});


/**
 * STEP FAILURE
 */
// Campaign Phase 8 — Failed
router.post('/campaign-leads/:id/failed', async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    if (!reason) {
      return res.status(400).json({ error: 'Failure reason is required' });
    }

    await markCampaignLeadFailed(id, reason);

    res.json({ success: true });
  } catch (err: any) {
    console.error('[MARK FAILED ERROR]', err);
    res.status(400).json({ error: err.message });
  }
});


// Campaign Phase 9 — Complete Step / Campaign Completion
router.post('/campaigns/:id/complete-step', async (req, res) => {
  try {
    const { id: campaignId } = req.params;

    const completed = await completeCampaignIfDone(campaignId);

    res.json({ completed });
  } catch (err: any) {
    console.error('[COMPLETE STEP ERROR]', err);
    res.status(400).json({ error: err.message });
  }
});

// Campaign Phase 10 — Reset
// POST /system/reset-inbox-counters
router.post('/system/reset-inbox-counters', async (req, res) => {
  const { resetHourly, resetDaily } = req.body;

  if (!resetHourly && !resetDaily) {
    return res.status(400).json({ error: 'Nothing to reset' });
  }

  await resetInboxCounters(resetHourly, resetDaily);

  res.json({ success: true });
});


// Campaign Step 11 - Bounces
router.post('/bounce', async (req, res) => {
  const { email, type, reason } = req.body;
  await handleBounce(email, type, reason);
  res.json({ success:true });
});

// Campaign Step 12 - Bounces 
router.post('/reply', async (req, res) => {
  await handleReply(req.body);
  res.json({ success:true });
});


  

export default router;
