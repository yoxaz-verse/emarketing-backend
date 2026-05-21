import { Router } from 'express';
import { requireAuth } from '../middleware/requireAuth';
import {
  attachLeadsToCampaign,
  detachLeadsFromCampaign,
  getInboxLockConflicts,
  syncCampaignInboxes,
  startCampaign,
  pauseCampaign
} from '../services/campaign.domain';
import { getCampaignRepliesFeed, getCampaignReplyOpenAnalytics } from '../services/emailTracking.service.js';

const router = Router();
router.use(requireAuth('viewer'));


import express from 'express';
import { supabase } from '../supabase';
import { resolveOperatorScope } from '../utils/resolveOperatorId';

console.log('[ATTACH_FIX_V2] campaign routes loaded (attach uses permanently_failed, not is_blocked)');

function resolveStatusCode(err: any) {
  const statusCode = Number(err?.statusCode ?? err?.status ?? 0);
  if (Number.isInteger(statusCode) && statusCode >= 400 && statusCode < 500) {
    return statusCode;
  }
  return 500;
}

function getNormalizedAuth(req: any) {
  const auth = req?.auth;
  if (!auth) {
    throw createHttpError('Unauthenticated', 401);
  }

  return {
    ...auth,
    role: String(auth.role ?? '').toLowerCase(),
    operator_id: auth.operator_id ?? null,
  };
}

async function assertCampaignAccess(req: any, campaignId: string) {
  const auth = getNormalizedAuth(req);
  let operatorScope: string | null;
  try {
    operatorScope = resolveOperatorScope({ ...req, auth } as any);
  } catch (error: any) {
    const message = String(error?.message ?? 'Forbidden');
    if (message.toLowerCase().includes('operator access required')) {
      throw createHttpError('Operator access required', 403);
    }
    throw createHttpError(message, 403);
  }
  if (!operatorScope) return;

  const { data: campaign, error } = await supabase
    .from('campaigns')
    .select('id, operator_id')
    .eq('id', campaignId)
    .maybeSingle();

  if (error) throw error;
  if (!campaign || String(campaign.operator_id ?? '') !== operatorScope) {
    throw createHttpError('Campaign not found', 404);
  }
}

function createHttpError(message: string, statusCode: number) {
  const error = new Error(message) as Error & { statusCode?: number };
  error.statusCode = statusCode;
  return error;
}

const DEFAULT_SENDER_DISPLAY_NAME = 'OBAOL Team';
const PERSONAL_NAME_HEURISTIC = /\b(joshua|jacob|alwin|joy)\b/i;

function senderWarningForName(name: string | null): string | null {
  const normalized = String(name ?? '').trim();
  if (!normalized) return null;
  if (PERSONAL_NAME_HEURISTIC.test(normalized)) {
    return 'Sender name looks personal. Recommended: team/brand identity (e.g., OBAOL Team).';
  }
  return null;
}

router.get('/:id/sender-settings', async (req, res) => {
  try {
    const campaignId = String(req.params.id ?? '');
    await assertCampaignAccess(req, campaignId);

    const { data, error } = await supabase
      .from('campaigns')
      .select('id,sender_display_name')
      .eq('id', campaignId)
      .maybeSingle();

    if (error) {
      const message = String((error as any)?.message ?? '');
      const code = String((error as any)?.code ?? '');
      const missingColumn = code === '42703' || message.includes('sender_display_name');
      if (missingColumn) {
        return res.json({
          sender_display_name: null,
          effective_sender_display_name: DEFAULT_SENDER_DISPLAY_NAME,
          warning: null,
          schema_ready: false,
        });
      }
      throw error;
    }

    const senderDisplayName = String((data as any)?.sender_display_name ?? '').trim() || null;
    return res.json({
      sender_display_name: senderDisplayName,
      effective_sender_display_name: senderDisplayName || DEFAULT_SENDER_DISPLAY_NAME,
      warning: senderWarningForName(senderDisplayName),
      schema_ready: true,
    });
  } catch (err: any) {
    return res.status(resolveStatusCode(err)).json({ error: err?.message ?? 'Failed to load sender settings' });
  }
});

router.patch('/:id/sender-settings', async (req, res) => {
  try {
    const campaignId = String(req.params.id ?? '');
    await assertCampaignAccess(req, campaignId);

    const rawValue = typeof req.body?.sender_display_name === 'string'
      ? req.body.sender_display_name
      : '';
    const trimmed = rawValue.trim();
    const nextValue = trimmed.length > 0 ? trimmed : null;

    const { error } = await supabase
      .from('campaigns')
      .update({ sender_display_name: nextValue })
      .eq('id', campaignId);

    if (error) {
      const message = String((error as any)?.message ?? '');
      const code = String((error as any)?.code ?? '');
      const missingColumn = code === '42703' || message.includes('sender_display_name');
      if (missingColumn) {
        return res.status(503).json({
          error: 'sender_display_name column is missing. Apply DB migration and retry.',
          code: 'SENDER_DISPLAY_NAME_SCHEMA_MISSING',
        });
      }
      throw error;
    }

    return res.json({
      success: true,
      sender_display_name: nextValue,
      effective_sender_display_name: nextValue || DEFAULT_SENDER_DISPLAY_NAME,
      warning: senderWarningForName(nextValue),
    });
  } catch (err: any) {
    return res.status(resolveStatusCode(err)).json({ error: err?.message ?? 'Failed to update sender settings' });
  }
});

router.get('/:id/inbox-locks', async (req, res) => {
  try {
    const campaignId = req.params.id;
    await assertCampaignAccess(req, campaignId);
    const campaignAccessRole = String(req?.auth?.role ?? '').toLowerCase();

    const { data: campaign, error: campaignError } = await supabase
      .from('campaigns')
      .select('id, operator_id')
      .eq('id', campaignId)
      .maybeSingle();

    if (campaignError) throw campaignError;
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    const { data: inboxRows, error: inboxRowsError } = await supabase
      .from('inboxes')
      .select('id');
    if (inboxRowsError) throw inboxRowsError;

    const inboxIds = (inboxRows ?? []).map((row: any) => String(row.id)).filter(Boolean);
    const conflicts = await getInboxLockConflicts(campaignId, inboxIds);
    const campaignOperatorId = String(campaign.operator_id ?? '');

    const locks = conflicts.map((row) => {
      const sameOperator = campaignAccessRole === 'admin' || String(row.blocking_operator_id ?? '') === campaignOperatorId;
      return {
        inbox_id: row.inbox_id,
        blocking_campaign_id: row.blocking_campaign_id,
        blocking_status: row.blocking_status,
        blocking_campaign_name: sameOperator
          ? row.blocking_campaign_name
          : 'Another active campaign',
      };
    });

    return res.json(locks);
  } catch (err: any) {
    console.error('[GET INBOX LOCKS ERROR]', err);
    return res.status(resolveStatusCode(err)).json({
      error: err.message ?? 'Failed to fetch inbox locks',
    });
  }
});

function isOperatorScopedRequest(req: any): boolean {
  const role = String(req?.auth?.role ?? '').toLowerCase();
  const isAdmin = role === 'admin' || role === 'superadmin';
  const hasOperatorId = String(req?.auth?.operator_id ?? '').trim().length > 0;
  return !isAdmin && hasOperatorId;
}

router.post('/:id/leads/attach', async (req, res) => {
  try {
    const campaignId = req.params.id;
    const { lead_ids } = req.body;
    await assertCampaignAccess(req, campaignId);

    if (!Array.isArray(lead_ids)) {
      return res.status(400).json({
        error: 'lead_ids must be an array',
      });
    }

    let scopedLeadIds = lead_ids;
    let skippedOutOfScope = 0;
    if (isOperatorScopedRequest(req)) {
      const operatorId = String(req?.auth?.operator_id ?? '').trim();
      const { data: ownedLeads, error: ownedLeadsError } = await supabase
        .from('leads')
        .select('id')
        .eq('operator_id', operatorId)
        .in('id', lead_ids);
      if (ownedLeadsError) throw ownedLeadsError;
      const allowedIds = new Set((ownedLeads ?? []).map((row: any) => String(row.id)));
      scopedLeadIds = lead_ids.filter((id: any) => allowedIds.has(String(id)));
      skippedOutOfScope = lead_ids.length - scopedLeadIds.length;
    }

    const result = await attachLeadsToCampaign(campaignId, scopedLeadIds);

    res.json({
      success: true,
      ...result,
      skipped_out_of_scope: skippedOutOfScope,
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
    await assertCampaignAccess(req, campaignId);
    if (folderIds.length === 0) {
      return res.status(400).json({ error: 'folder_ids must be a non-empty array' });
    }

    let memberQuery: any = supabase
      .from('leads')
      .select('id')
      .in('folder_id', folderIds);
    if (isOperatorScopedRequest(req)) {
      memberQuery = memberQuery.eq('operator_id', String(req?.auth?.operator_id ?? ''));
    }
    const { data: members, error: memberError } = await memberQuery;
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
    await assertCampaignAccess(req, campaignId);

    if (!Array.isArray(lead_ids)) {
      return res.status(400).json({
        error: 'lead_ids must be an array',
      });
    }

    let scopedLeadIds = lead_ids;
    let skippedOutOfScope = 0;
    if (isOperatorScopedRequest(req)) {
      const operatorId = String(req?.auth?.operator_id ?? '').trim();
      const { data: ownedLeads, error: ownedLeadsError } = await supabase
        .from('leads')
        .select('id')
        .eq('operator_id', operatorId)
        .in('id', lead_ids);
      if (ownedLeadsError) throw ownedLeadsError;
      const allowedIds = new Set((ownedLeads ?? []).map((row: any) => String(row.id)));
      scopedLeadIds = lead_ids.filter((id: any) => allowedIds.has(String(id)));
      skippedOutOfScope = lead_ids.length - scopedLeadIds.length;
    }

    const result = await detachLeadsFromCampaign(campaignId, scopedLeadIds);
    return res.json({
      success: true,
      ...result,
      skipped_out_of_scope: skippedOutOfScope,
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
    await assertCampaignAccess(req, campaignId);

    if (!Array.isArray(lead_ids)) {
      return res.status(400).json({
        error: 'lead_ids must be an array',
      });
    }

    let scopedLeadIds = lead_ids;
    let skippedOutOfScope = 0;
    if (isOperatorScopedRequest(req)) {
      const operatorId = String(req?.auth?.operator_id ?? '').trim();
      const { data: ownedLeads, error: ownedLeadsError } = await supabase
        .from('leads')
        .select('id')
        .eq('operator_id', operatorId)
        .in('id', lead_ids);
      if (ownedLeadsError) throw ownedLeadsError;
      const allowedIds = new Set((ownedLeads ?? []).map((row: any) => String(row.id)));
      scopedLeadIds = lead_ids.filter((id: any) => allowedIds.has(String(id)));
      skippedOutOfScope = lead_ids.length - scopedLeadIds.length;
    }

    const result = await detachLeadsFromCampaign(campaignId, scopedLeadIds);
    return res.json({
      success: true,
      ...result,
      skipped_out_of_scope: skippedOutOfScope,
    });
  } catch (err: any) {
    console.error('[DETACH LEADS ERROR]', err);
    return res.status(resolveStatusCode(err)).json({
      error: err.message ?? 'Failed to detach leads',
    });
  }
});

router.get('/:id/mutation-health', async (req, res) => {
  try {
    const campaignId = req.params.id;
    await assertCampaignAccess(req, campaignId);
    const apiBase = String(process.env.NEXT_PUBLIC_API_BASE_URL ?? '').trim();
    return res.json({
      ok: true,
      campaign_id: campaignId,
      diagnostics: {
        api_base_configured: apiBase.length > 0,
        route_contract_version: 'campaign-mutations-v1',
        required_routes: {
          attach: '/campaigns/:id/leads/attach',
          detach: '/campaigns/:id/leads/detach',
          attach_folder: '/campaigns/:id/leads/attach-folder',
          campaign_delete: '/crud/campaigns/:id',
        },
      },
    });
  } catch (err: any) {
    console.error('[CAMPAIGN MUTATION HEALTH ERROR]', err);
    return res.status(resolveStatusCode(err)).json({
      ok: false,
      error: err.message ?? 'Failed to fetch mutation health',
    });
  }
});

router.post('/:id/inboxes/sync', async (req, res) => {
  try {
    const campaignId = req.params.id;
    await assertCampaignAccess(req, campaignId);
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

router.get('/:id/reply-open-analytics', async (req, res) => {
  try {
    const campaignId = req.params.id;
    await assertCampaignAccess(req, campaignId);
    const summary = await getCampaignReplyOpenAnalytics(campaignId);
    return res.json(summary);
  } catch (err: any) {
    console.error('[CAMPAIGN REPLY OPEN ANALYTICS ERROR]', err);
    return res.status(resolveStatusCode(err)).json({ error: err.message ?? 'Failed to fetch campaign analytics' });
  }
});

router.get('/:id/replies-feed', async (req, res) => {
  try {
    const campaignId = req.params.id;
    await assertCampaignAccess(req, campaignId);
    const rows = await getCampaignRepliesFeed(campaignId);
    return res.json(rows);
  } catch (err: any) {
    console.error('[CAMPAIGN REPLIES FEED ERROR]', err);
    return res.status(resolveStatusCode(err)).json({ error: err.message ?? 'Failed to fetch campaign replies feed' });
  }
});



// Campaign Step 5 , 13 here we go again
router.post('/:id/start', async (req, res) => {
  const campaignId = String(req.params.id ?? '');
  let auth: ReturnType<typeof getNormalizedAuth> | null = null;
  try {
    auth = getNormalizedAuth(req);
    await assertCampaignAccess({ ...req, auth }, campaignId);
    await startCampaign(campaignId, auth);
    console.info('[START_CAMPAIGN_SUCCESS]', {
      campaignId,
      role: auth.role,
      hasOperatorId: Boolean(String(auth.operator_id ?? '').trim()),
    });
    res.json({ success: true });
  } catch (err: any) {
    const statusCode = resolveStatusCode(err);
    console.error('[START CAMPAIGN ERROR]', {
      campaignId,
      role: auth?.role ?? String(req?.auth?.role ?? '').toLowerCase(),
      hasOperatorId: Boolean(String(auth?.operator_id ?? req?.auth?.operator_id ?? '').trim()),
      statusCode,
      message: err?.message ?? 'Failed to start campaign',
    });
    res.status(statusCode).json({ error: err.message ?? 'Failed to start campaign' });
  }
});

// Campaign Step 12
router.post('/:id/pause', async (req, res) => {
  const campaignId = String(req.params.id ?? '');
  let auth: ReturnType<typeof getNormalizedAuth> | null = null;
  try {
    auth = getNormalizedAuth(req);
    await assertCampaignAccess({ ...req, auth }, campaignId);
    await pauseCampaign(campaignId, auth);
    console.info('[PAUSE_CAMPAIGN_SUCCESS]', {
      campaignId,
      role: auth.role,
      hasOperatorId: Boolean(String(auth.operator_id ?? '').trim()),
    });
    res.json({ success: true });
  } catch (err: any) {
    const statusCode = resolveStatusCode(err);
    console.error('[PAUSE CAMPAIGN ERROR]', {
      campaignId,
      role: auth?.role ?? String(req?.auth?.role ?? '').toLowerCase(),
      hasOperatorId: Boolean(String(auth?.operator_id ?? req?.auth?.operator_id ?? '').trim()),
      statusCode,
      message: err?.message ?? 'Failed to pause campaign',
    });
    res.status(statusCode).json({ error: err.message ?? 'Failed to pause campaign' });
  }
});

export default router;
