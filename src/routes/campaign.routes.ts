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
import { getSendingLimitsConfig } from '../services/sendingLimitsConfig.service';
import { normalizePagination } from '../utils/pagination';

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

router.get('/:id/workspace', async (req, res) => {
  const startedAt = performance.now();
  try {
    const campaignId = String(req.params.id ?? '');
    await assertCampaignAccess(req, campaignId);
    const { data: campaign, error: campaignError } = await supabase
      .from('campaigns')
      .select('*')
      .eq('id', campaignId)
      .maybeSingle();
    if (campaignError) throw campaignError;
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    const operatorId = String((campaign as any).operator_id ?? '').trim();
    const sequenceId = String((campaign as any).sequence_id ?? '').trim();
    const inboxFilter = operatorId
      ? `operator_id.is.null,operator_id.eq.${operatorId}`
      : 'operator_id.is.null';
    const [operatorResult, inboxResult, campaignInboxesResult, sequenceResult, stepsResult, foldersResult, sendingLimits] = await Promise.all([
      operatorId
        ? supabase.from('operators').select('id,name').eq('id', operatorId).maybeSingle()
        : Promise.resolve({ data: null, error: null }),
      supabase
        .from('inboxes')
        .select('id,email_address,operator_id,sending_domain_id,daily_limit,hourly_limit,warmup_enabled,warmup_day')
        .or(inboxFilter)
        .order('email_address', { ascending: true }),
      supabase.from('campaign_inboxes').select('id,campaign_id,inbox_id,created_at').eq('campaign_id', campaignId),
      sequenceId
        ? supabase.from('sequences').select('*').eq('id', sequenceId).maybeSingle()
        : Promise.resolve({ data: null, error: null }),
      sequenceId
        ? supabase.from('sequence_steps').select('*').eq('sequence_id', sequenceId).order('step_number', { ascending: true })
        : Promise.resolve({ data: [], error: null }),
      operatorId
        ? supabase.from('lead_folders').select('id,name,operator_id').eq('operator_id', operatorId).order('name', { ascending: true })
        : Promise.resolve({ data: [], error: null }),
      getSendingLimitsConfig().catch(() => null),
    ]);
    const firstError = [operatorResult, inboxResult, campaignInboxesResult, sequenceResult, stepsResult, foldersResult]
      .find((result: any) => result?.error)?.error;
    if (firstError) throw firstError;

    const inboxes = inboxResult.data ?? [];
    const inboxIds = inboxes.map((row: any) => String(row.id)).filter(Boolean);
    const domainIds = Array.from(new Set(inboxes.map((row: any) => String(row.sending_domain_id ?? '')).filter(Boolean)));
    const [conflicts, domainResult] = await Promise.all([
      getInboxLockConflicts(campaignId, inboxIds),
      domainIds.length > 0
        ? supabase.from('sending_domains').select('id,spf_verified,dkim_verified,dmarc_verified').in('id', domainIds)
        : Promise.resolve({ data: [], error: null }),
    ]);
    if (domainResult.error) throw domainResult.error;

    const role = String(req?.auth?.role ?? '').toLowerCase();
    const locks = conflicts.map((row) => ({
      inbox_id: row.inbox_id,
      blocking_campaign_id: row.blocking_campaign_id,
      blocking_status: row.blocking_status,
      blocking_campaign_name: role === 'admin' || role === 'superadmin' || String(row.blocking_operator_id ?? '') === operatorId
        ? row.blocking_campaign_name
        : 'Another active campaign',
    }));
    const senderDisplayName = String((campaign as any).sender_display_name ?? '').trim() || null;
    const durationMs = Math.round(performance.now() - startedAt);
    res.setHeader('Server-Timing', `campaign-workspace;dur=${durationMs}`);
    return res.json({
      campaign,
      assigned_operator_name: String((operatorResult.data as any)?.name ?? '').trim() || null,
      inboxes,
      campaign_inboxes: campaignInboxesResult.data ?? [],
      locked_inboxes: locks,
      sending_domains: domainResult.data ?? [],
      sequence: sequenceResult.data ?? null,
      sequence_steps: stepsResult.data ?? [],
      lead_folders: foldersResult.data ?? [],
      sending_limits: sendingLimits,
      sender_settings: {
        sender_display_name: senderDisplayName,
        effective_sender_display_name: senderDisplayName || DEFAULT_SENDER_DISPLAY_NAME,
        warning: senderWarningForName(senderDisplayName),
        schema_ready: true,
      },
      mutation_health: { ok: true, routeContractVersion: 'campaign-mutations-v1' },
    });
  } catch (err: any) {
    return res.status(resolveStatusCode(err)).json({ error: err?.message ?? 'Failed to load campaign workspace' });
  }
});

router.get('/:id/health-summary', async (req, res) => {
  try {
    const campaignId = String(req.params.id ?? '');
    await assertCampaignAccess(req, campaignId);
    const [campaignResult, runnerResult, sendResult] = await Promise.all([
      supabase.from('campaigns').select('id,status').eq('id', campaignId).maybeSingle(),
      supabase.from('system_events')
        .select('type,created_at,message,meta')
        .eq('entity_id', campaignId)
        .in('type', ['CAMPAIGN_BATCH_EXECUTED', 'CAMPAIGN_BATCH_EXECUTION_FATAL'])
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabase.from('email_logs').select('sent_at').eq('campaign_id', campaignId).eq('status', 'sent')
        .order('sent_at', { ascending: false }).limit(1).maybeSingle(),
    ]);
    const firstError = [campaignResult, runnerResult, sendResult].find((result) => result.error)?.error;
    if (firstError) throw firstError;
    const eventAt = String((runnerResult.data as any)?.created_at ?? '').trim() || null;
    const age = eventAt ? Math.max(0, Math.floor((Date.now() - new Date(eventAt).getTime()) / 1000)) : null;
    const isRunning = String((campaignResult.data as any)?.status ?? '').toLowerCase() === 'running';
    const state = !isRunning ? 'idle'
      : String((runnerResult.data as any)?.type ?? '') === 'CAMPAIGN_BATCH_EXECUTION_FATAL' ? 'failed'
        : age !== null && age <= 150 ? 'healthy' : 'stale';
    const meta = ((runnerResult.data as any)?.meta ?? {}) as Record<string, any>;
    return res.json({
      runner_health: {
        state,
        last_heartbeat_at: eventAt,
        heartbeat_age_seconds: age,
        last_successful_send_at: (sendResult.data as any)?.sent_at ?? null,
        claimed_count: Number(meta.claimed_count ?? 0),
        sent_count: Number(meta.sent_count ?? 0),
        failed_count: Number(meta.failed_count ?? 0),
        skipped_count: Number(meta.skipped_count ?? 0),
        claim_reason: meta.claim_reason ?? null,
        skip_reasons: meta.skip_reasons ?? {},
        fatal_error: meta.fatal_error ?? null,
        queue_snapshot_after: meta.queue_snapshot_after ?? null,
      },
    });
  } catch (err: any) {
    return res.status(resolveStatusCode(err)).json({ error: err?.message ?? 'Failed to load campaign health summary' });
  }
});

router.get('/:id/leads/page', async (req, res) => {
  try {
    const campaignId = String(req.params.id ?? '');
    await assertCampaignAccess(req, campaignId);
    const { page, pageSize } = normalizePagination(req.query.page, req.query.page_size, 50);
    const scope = String(req.query.scope ?? 'available') === 'attached' ? 'attached' : 'available';
    const query = String(req.query.q ?? '').trim() || null;
    const folderId = String(req.query.folder_id ?? '').trim() || null;
    const { data, error } = await supabase.rpc('dashboard_campaign_lead_page', {
      p_campaign_id: campaignId,
      p_scope: scope,
      p_query: query,
      p_folder_id: folderId,
      p_offset: (page - 1) * pageSize,
      p_limit: pageSize,
    });
    if (error) throw error;
    const payload = (data ?? {}) as { rows?: unknown[]; total?: number };
    return res.json({
      rows: Array.isArray(payload.rows) ? payload.rows : [],
      total: Number(payload.total ?? 0),
      page,
      page_size: pageSize,
      scope,
    });
  } catch (err: any) {
    return res.status(resolveStatusCode(err)).json({ error: err?.message ?? 'Failed to load campaign leads' });
  }
});

router.get('/:id/progress/page', async (req, res) => {
  try {
    const campaignId = String(req.params.id ?? '');
    await assertCampaignAccess(req, campaignId);
    const { page, pageSize } = normalizePagination(req.query.page, req.query.page_size, 50);
    const { data, error, count } = await supabase
      .from('campaign_leads')
      .select('id,campaign_id,lead_id,status,status_reason,current_step,last_sent_at,assigned_inbox_id,leads:lead_id(id,email,email_eligibility,is_suppressed)', { count: 'exact' })
      .eq('campaign_id', campaignId)
      .order('created_at', { ascending: false })
      .range((page - 1) * pageSize, page * pageSize - 1);
    if (error) throw error;
    return res.json({ rows: data ?? [], total: Number(count ?? 0), page, page_size: pageSize });
  } catch (err: any) {
    return res.status(resolveStatusCode(err)).json({ error: err?.message ?? 'Failed to load campaign progress' });
  }
});

router.get('/:id/progress-summary', async (req, res) => {
  try {
    const campaignId = String(req.params.id ?? '');
    await assertCampaignAccess(req, campaignId);
    const { data, error } = await supabase.rpc('dashboard_campaign_progress_summary', {
      p_campaign_id: campaignId,
    });
    if (error) throw error;
    return res.json(data ?? { total: 0, groups: [], lead_mix: { eligible: 0, risky: 0, suppressed: 0 } });
  } catch (err: any) {
    return res.status(resolveStatusCode(err)).json({ error: err?.message ?? 'Failed to load campaign progress summary' });
  }
});

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

async function getCampaignOperatorId(campaignId: string): Promise<string> {
  const { data: campaign, error } = await supabase
    .from('campaigns')
    .select('id, operator_id')
    .eq('id', campaignId)
    .maybeSingle();

  if (error) throw error;
  if (!campaign) throw createHttpError('Campaign not found', 404);

  const operatorId = String(campaign.operator_id ?? '').trim();
  if (!operatorId) {
    throw createHttpError('Campaign is missing an assigned operator', 409);
  }
  return operatorId;
}

async function scopeLeadIdsToCampaignOperator(campaignId: string, leadIds: any[]) {
  const campaignOperatorId = await getCampaignOperatorId(campaignId);
  const requestedLeadIds = Array.from(new Set(leadIds.map((id: any) => String(id)).filter(Boolean)));
  if (requestedLeadIds.length === 0) {
    return {
      leadIds: [] as string[],
      skippedOutOfScope: 0,
      requestedLeadIds,
      campaignOperatorId,
    };
  }

  const { data: ownedLeads, error: ownedLeadsError } = await supabase
    .from('leads')
    .select('id')
    .eq('operator_id', campaignOperatorId)
    .in('id', requestedLeadIds);
  if (ownedLeadsError) throw ownedLeadsError;

  const allowedIds = new Set((ownedLeads ?? []).map((row: any) => String(row.id)));
  const scopedLeadIds = requestedLeadIds.filter((id) => allowedIds.has(String(id)));
  return {
    leadIds: scopedLeadIds,
    skippedOutOfScope: requestedLeadIds.length - scopedLeadIds.length,
    requestedLeadIds,
    campaignOperatorId,
  };
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

    const { leadIds: scopedLeadIds, skippedOutOfScope } =
      await scopeLeadIdsToCampaignOperator(campaignId, lead_ids);

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

    const campaignOperatorId = await getCampaignOperatorId(campaignId);
    const memberQuery: any = supabase
      .from('leads')
      .select('id, operator_id')
      .in('folder_id', folderIds);
    const { data: members, error: memberError } = await memberQuery;
    if (memberError) throw memberError;
    const requestedLeadIds: string[] = Array.from(new Set((members ?? []).map((m: any) => String(m.id)).filter(Boolean)));
    const leadIds: string[] = Array.from(new Set(
      (members ?? [])
        .filter((m: any) => String(m.operator_id ?? '').trim() === campaignOperatorId)
        .map((m: any) => String(m.id))
        .filter(Boolean)
    ));
    const skippedOutOfScope = requestedLeadIds.length - leadIds.length;
    if (leadIds.length === 0) {
      return res.json({
        success: true,
        requested: 0,
        inserted: 0,
        detached: 0,
        skipped_existing: 0,
        skipped_ineligible: 0,
        skipped_missing: 0,
        skipped_out_of_scope: skippedOutOfScope,
      });
    }

    const result = await attachLeadsToCampaign(campaignId, leadIds);
    return res.json({
      success: true,
      ...result,
      source: 'folder_snapshot',
      folder_ids: folderIds,
      skipped_out_of_scope: skippedOutOfScope,
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
      code: String(err?.code ?? ''),
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
      code: String(err?.code ?? ''),
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
