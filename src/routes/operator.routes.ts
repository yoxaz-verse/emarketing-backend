import { Router, Request, Response } from 'express';
import {
  uploadLeads,
  assignSequence,
  startCampaign,
  pauseCampaign,
  resumeCampaign
} from '../services/operatorService.js';
import { getCampaignStats } from '../services/operatorReadService.js';
import { getOperatorReplies, reviewLeadInterest } from '../services/operatorRepliesService.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { getEffectiveOperatorId } from '../utils/getEffectiveOperatorId.js';

const router = Router();

router.use(requireAuth('viewer'));

router.post('/leads/upload', async (req: Request, res: Response) => {
  const requestBody = req.body ?? {};
  const inputRows = requestBody.rows ?? requestBody.leads ?? [];
  const mapping = requestBody.mapping ?? {};
  let operatorId: string | null = null;
  const authCtx = req.auth;

  try {
    operatorId = getEffectiveOperatorId(req);
    console.info('[LEADS_UPLOAD_SANITY]', {
      stage: 'before_upload',
      authRole: authCtx?.role ?? null,
      authType: authCtx?.type ?? null,
      authOperatorId: authCtx?.operator_id ?? null,
      resolvedOperatorId: operatorId,
      rowCount: Array.isArray(inputRows) ? inputRows.length : 0,
      mappedFields: Object.keys(mapping),
    });

    const report = await uploadLeads(operatorId, requestBody);
    console.info('[LEADS_UPLOAD_SANITY]', {
      stage: 'upload_success',
      authRole: authCtx?.role ?? null,
      resolvedOperatorId: operatorId,
      insertedCount: report.insertedCount,
      duplicateCount: report.duplicateCount,
      invalidCount: report.invalidCount,
      statusBranch: 200,
    });
    return res.json(report);
  } catch (err: any) {
    console.error('[LEADS_UPLOAD_ERROR]', {
      stage: 'upload',
      operatorId,
      rowCount: Array.isArray(inputRows) ? inputRows.length : 0,
      mappedFields: Object.keys(mapping),
      message: err?.message ?? 'Unknown error',
      code: err?.code ?? null,
    });

    const msg = String(err?.message ?? '').toLowerCase();
    let status = 500;
    if (msg.includes('operator_id is required')) status = 400;
    else if (msg.includes('unauthenticated') || msg.includes('authentication')) status = 401;
    else if (
      msg.includes('forbidden') ||
      msg.includes('insufficient permissions') ||
      msg.includes('operator access required')
    ) {
      status = 403;
    }

    console.info('[LEADS_UPLOAD_SANITY]', {
      stage: 'upload_error',
      authRole: authCtx?.role ?? null,
      authOperatorId: authCtx?.operator_id ?? null,
      resolvedOperatorId: operatorId,
      statusBranch: status,
      errorMessage: err?.message ?? 'Unknown error',
    });

    return res.status(status).json({
      success: false,
      error: err?.message || 'Lead import failed',
    });
  }
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

router.patch('/replies/:leadId/review', async (req, res) => {
  try {
    const leadId = String(req.params.leadId ?? '');
    const interestStatus = String(req.body?.interest_status ?? '').toLowerCase();
    const interestNote = req.body?.interest_note ? String(req.body.interest_note) : null;

    if (!leadId) {
      return res.status(400).json({ error: 'leadId is required' });
    }
    if (!['unreviewed', 'interested', 'not_interested'].includes(interestStatus)) {
      return res.status(400).json({ error: 'interest_status must be unreviewed | interested | not_interested' });
    }

    const reviewedBy = String((req as any)?.auth?.user_id ?? (req as any)?.auth?.operator_id ?? '');
    const result = await reviewLeadInterest({
      leadId,
      interest_status: interestStatus as 'unreviewed' | 'interested' | 'not_interested',
      interest_note: interestNote,
      reviewed_by: reviewedBy || null,
    });
    return res.json(result);
  } catch (err: any) {
    return res.status(400).json({ error: err?.message ?? 'Failed to review reply interest' });
  }
});

export default router;
