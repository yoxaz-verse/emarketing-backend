import { Router, Request, Response } from 'express';
import {
  uploadLeads,
  assignSequence,
  startCampaign,
  pauseCampaign,
  resumeCampaign
} from '../services/operatorService.js';
import { getCampaignStats } from '../services/operatorReadService.js';
import {
  getOperatorReplies,
  getUnmatchedReplyEvents,
  mapUnmatchedReplyToLead,
  reviewLeadInterest
} from '../services/operatorRepliesService.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { getEffectiveOperatorId } from '../utils/getEffectiveOperatorId.js';
import { supabase } from '../supabase.js';

const router = Router();

router.use(requireAuth('viewer'));

router.post('/leads/upload', async (req: Request, res: Response) => {
  const requestBody = req.body ?? {};
  const inputRows = requestBody.rows ?? requestBody.leads ?? [];
  const mapping = requestBody.mapping ?? {};
  const duplicateMode = requestBody.duplicate_mode ?? 'skip';
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
      duplicateMode,
    });

    const report = await uploadLeads(operatorId, requestBody);
    console.info('[LEADS_UPLOAD_SANITY]', {
      stage: 'upload_success',
      authRole: authCtx?.role ?? null,
      resolvedOperatorId: operatorId,
      insertedCount: report.insertedCount,
      duplicateCount: report.duplicateCount,
      invalidCount: report.invalidCount,
      duplicateMode,
      statusBranch: 200,
    });
    return res.json(report);
  } catch (err: any) {
    console.error('[LEADS_UPLOAD_ERROR]', {
      stage: 'upload',
      operatorId,
      rowCount: Array.isArray(inputRows) ? inputRows.length : 0,
      mappedFields: Object.keys(mapping),
      duplicateMode,
      message: err?.message ?? 'Unknown error',
      code: err?.code ?? null,
    });

    const msg = String(err?.message ?? '').toLowerCase();
    let status = 500;
    if (msg.includes('operator_id is required')) status = 400;
    else if (msg.includes('invalid duplicate_mode')) status = 400;
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
  const role = String(req?.auth?.role ?? '').toLowerCase();
  const isAdmin = role === 'admin' || role === 'superadmin';
  const operatorIdFromQuery = typeof req.query.operator_id === 'string' ? req.query.operator_id : null;

  const operatorId = isAdmin
    ? operatorIdFromQuery
    : getEffectiveOperatorId(req);

  const campaignId = typeof req.query.campaign_id === 'string' ? req.query.campaign_id : null;
  const reviewStatusRaw = typeof req.query.review_status === 'string' ? req.query.review_status : 'all';
  const reviewStatus =
    reviewStatusRaw === 'unreviewed' || reviewStatusRaw === 'reviewed' ? reviewStatusRaw : 'all';
  const includeUnmatched = String(req.query.include_unmatched ?? '').toLowerCase() === 'true';
  const replies = await getOperatorReplies(operatorId, { campaignId, reviewStatus });
  if (!includeUnmatched) {
    return res.json(replies);
  }

  const unmatched = await getUnmatchedReplyEvents(operatorId, { campaignId });
  return res.json({ replies, unmatched });
});

router.get('/replies/operators', async (req, res) => {
  try {
    const role = String(req?.auth?.role ?? '').toLowerCase();
    const isAdmin = role === 'admin' || role === 'superadmin';
    const scopedOperatorId = req?.auth?.operator_id ? String(req.auth.operator_id) : null;

    if (!isAdmin && !scopedOperatorId) {
      return res.json([]);
    }

    const { data: activeUsers, error: activeUsersError } = await supabase
      .from('users')
      .select('operator_id,email')
      .eq('active', true)
      .not('operator_id', 'is', null);

    if (activeUsersError) {
      throw activeUsersError;
    }

    const activeByOperator = new Map<string, string>();
    for (const row of Array.isArray(activeUsers) ? activeUsers : []) {
      const operatorId = row?.operator_id ? String(row.operator_id) : '';
      if (!operatorId) continue;
      if (!activeByOperator.has(operatorId)) {
        const email = row?.email ? String(row.email) : '';
        activeByOperator.set(operatorId, email);
      }
    }

    const allActiveOperatorIds = Array.from(activeByOperator.keys());
    const visibleOperatorIds = isAdmin
      ? allActiveOperatorIds
      : (scopedOperatorId ? allActiveOperatorIds.filter((id) => id === scopedOperatorId) : []);

    if (visibleOperatorIds.length === 0) {
      return res.json([]);
    }

    const { data: operators, error: operatorsError } = await supabase
      .from('operators')
      .select('id,name')
      .in('id', visibleOperatorIds);

    if (operatorsError) {
      throw operatorsError;
    }

    const nameById = new Map<string, string>();
    for (const row of Array.isArray(operators) ? operators : []) {
      const id = row?.id ? String(row.id) : '';
      if (!id) continue;
      const name = row?.name ? String(row.name).trim() : '';
      if (name) {
        nameById.set(id, name);
      }
    }

    const options = visibleOperatorIds.map((id) => {
      const fallbackEmail = activeByOperator.get(id) || '';
      const label = nameById.get(id) || fallbackEmail || `Operator ${id.slice(0, 8)}`;
      return { id, label };
    });

    options.sort((a, b) => a.label.localeCompare(b.label));
    return res.json(options);
  } catch (err: any) {
    return res.status(500).json({ error: err?.message ?? 'Failed to load reply operators' });
  }
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

router.patch('/replies/unmatched/:replyEventId/map', async (req, res) => {
  try {
    const replyEventId = String(req.params.replyEventId ?? '');
    const leadId = req.body?.lead_id ? String(req.body.lead_id) : '';
    const leadEmail = req.body?.lead_email ? String(req.body.lead_email) : '';
    const campaignLeadId = req.body?.campaign_lead_id ? String(req.body.campaign_lead_id) : null;
    if (!replyEventId) {
      return res.status(400).json({ error: 'replyEventId is required' });
    }
    const reviewedBy = String((req as any)?.auth?.user_id ?? (req as any)?.auth?.operator_id ?? '') || null;
    const result = await mapUnmatchedReplyToLead({
      replyEventId,
      leadId: leadId || undefined,
      leadEmail: leadEmail || undefined,
      campaignLeadId,
      reviewedBy,
    });
    return res.json(result);
  } catch (err: any) {
    return res.status(400).json({ error: err?.message ?? 'Failed to map unmatched reply' });
  }
});

export default router;
