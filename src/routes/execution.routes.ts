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
  requeueRiskyPausedLeads,
  requeueStaleProcessingLeads,
  getCampaignExecutionWakeState,
  getCampaignExecutionDiagnostics,
  runCampaignExecutionBatch,
} from '../services/execution.service';
import { supabase } from '../supabase';
import { ingestInboundReply } from '../services/replyIngestService.js';
import { initiateCampaignVoiceCall } from '../services/voice/voiceExecution.service';

const router = Router();

// router.use(requireAuth('operator'));


// Campaign Step 6
// Campaign Step 6 (CORRECTED)
router.get('/campaigns/:id/next-executions', async (req, res) => {
  try {
    const { id: campaignId } = req.params;
    const batchSize = Number(req.query.batch_size ?? 10);

    const claim = await getNextCampaignExecutions(
      campaignId,
      batchSize
    );

    const claimedCount = Number(claim?.meta?.claimed_count ?? 0);
    const reason = String(claim?.meta?.reason ?? '');
    const shouldSend = claimedCount > 0;
    res.json({
      executions: claim.executions,
      meta: claim.meta,
      runner: {
        should_send: shouldSend,
        claimed_count: claimedCount,
        reason: reason || null,
        queue_snapshot: {
          queued_count: Number(claim?.meta?.queued_count ?? 0),
          processing_count: Number(claim?.meta?.processing_count ?? 0),
          paused_count: Number(claim?.meta?.paused_count ?? 0),
          pending_count: Number(claim?.meta?.pending_count ?? 0),
        },
      },
    });
  } catch (err: any) {
    console.error('[NEXT EXECUTIONS ERROR]', err);
    res.status(400).json({ error: err.message });
  }
});

// Backend-orchestrated batch runner (new primary path).
router.post('/campaigns/:id/run-batch', async (req, res) => {
  try {
    const { id: campaignId } = req.params;
    const batchSize = Number(req.query.batch_size ?? req.body?.batch_size ?? 10);

    const summary = await runCampaignExecutionBatch(campaignId, batchSize);
    const statusCode = summary.fatal_error ? 500 : 200;
    res.status(statusCode).json(summary);
  } catch (err: any) {
    console.error('[RUN BATCH ERROR]', err);
    res.status(400).json({ error: err.message ?? 'Failed to run campaign batch' });
  }
});

router.get('/campaigns/:id/diagnostics', async (req, res) => {
  try {
    const { id: campaignId } = req.params;
    const diagnostics = await getCampaignExecutionDiagnostics(campaignId);
    res.json(diagnostics);
  } catch (err: any) {
    console.error('[EXECUTION DIAGNOSTICS ERROR]', err);
    res.status(400).json({ error: err.message ?? 'Failed to read execution diagnostics' });
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

router.post('/system/requeue-risky-paused', async (_req, res) => {
  try {
    const result = await requeueRiskyPausedLeads();
    res.json({ success: true, ...result });
  } catch (err: any) {
    console.error('[REQUEUE RISKY PAUSED ERROR]', err);
    res.status(400).json({ error: err.message ?? 'Failed to requeue risky paused leads' });
  }
});

router.post('/system/requeue-stale-processing', async (req, res) => {
  try {
    const campaignIdRaw = req.body?.campaign_id;
    const campaignId = typeof campaignIdRaw === 'string' && campaignIdRaw.trim().length > 0
      ? campaignIdRaw.trim()
      : undefined;
    const olderThanRaw = req.body?.older_than_minutes;
    const olderThanMinutes = Number.isFinite(Number(olderThanRaw))
      ? Number(olderThanRaw)
      : undefined;

    const result = await requeueStaleProcessingLeads({
      campaignId,
      olderThanMinutes,
    });

    res.json({ success: true, ...result });
  } catch (err: any) {
    console.error('[REQUEUE STALE PROCESSING ERROR]', err);
    res.status(400).json({ error: err.message ?? 'Failed to requeue stale processing leads' });
  }
});

router.get('/system/wake-check', async (req, res) => {
  try {
    const lastSeenVersion = typeof req.query.last_seen_version === 'string'
      ? req.query.last_seen_version
      : undefined;
    const wake = await getCampaignExecutionWakeState(lastSeenVersion);
    res.json(wake);
  } catch (err: any) {
    console.error('[WAKE CHECK ERROR]', err);
    const statusCode = Number(err?.statusCode ?? 400);
    res.status(statusCode).json({ error: err.message ?? 'Failed to read wake-check state' });
  }
});


// Campaign Step 11 - Bounces
router.post('/bounce', async (req, res) => {
  const { email, type, reason } = req.body;
  await handleBounce(email, type, reason);
  res.json({ success: true });
});

// Campaign Step 12 - Bounces 
router.post('/reply', async (req, res) => {
  const result = await ingestInboundReply({
    from_email: req.body?.from_email ?? req.body?.from,
    message: req.body?.message,
    inbox_email: req.body?.inbox_email,
    message_id: req.body?.message_id,
    received_at: req.body?.received_at,
    leadId: req.body?.leadId,
  });
  res.json(result);
});

// Campaign Phase 13 - Voice Call Initiation
router.post('/start-voice-call', async (req, res) => {
  try {
    const { campaign_lead_id } = req.body;
    if (!campaign_lead_id) {
      return res.status(400).json({ error: 'campaign_lead_id is required' });
    }

    const result = await initiateCampaignVoiceCall(campaign_lead_id);
    res.json(result);
  } catch (err: any) {
    console.error('[START VOICE CALL ERROR]', err);
    res.status(400).json({ error: err.message });
  }
});




export default router;
