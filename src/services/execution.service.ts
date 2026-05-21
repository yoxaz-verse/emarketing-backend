import { supabase } from '../supabase';
import { decryptSecret } from '../utils/sendEncryption';
import { updateRow } from './crudService';
import { createSmtpTransport } from './email/smtpTransport';
import { renderPlainTextAsHtml } from './email/emailBodyRender';
import { makePixelToken } from './emailTracking.service.js';
import {
  getSendingLimitsConfig,
  isNowWithinSendingSchedule,
} from './sendingLimitsConfig.service';
import { allocateCampaignSender } from './sending/sendAllocator.service';

const RUNNER_WINDOW_TIMEZONE = 'Asia/Kolkata';
const RUNNER_WINDOW_START_HOUR = 9;
const RUNNER_WINDOW_END_HOUR = 18;
const DEFAULT_STALE_PROCESSING_TIMEOUT_MINUTES = 10;
const FIXED_CAMPAIGN_SENDER_NAME = 'OBAOL Team';
const FORBIDDEN_SIGNOFF_MARKERS = ['regards, jacob', 'regards, joshua', 'joshua', 'jacob alwin joy', 'jacob supreme'];

type EmptyClaimReason =
  | 'schedule_blocked'
  | 'no_queued_leads'
  | 'all_processing'
  | 'all_paused'
  | 'claim_function_unavailable'
  | 'no_claimable_rows';

export type ClaimExecutionResult = {
  executions: any[];
  meta: {
    campaign_id: string;
    batch_size: number;
    queued_count: number;
    processing_count: number;
    paused_count: number;
    pending_count: number;
    stale_requeued_count: number;
    claimed_count: number;
    reason: EmptyClaimReason | null;
    schedule_allowed: boolean;
    schedule_reason: string | null;
    claim_path?: 'rpc' | 'fallback';
  };
};

async function claimCampaignExecutionsViaFallback(
  campaignId: string,
  batchSize: number
) {
  return supabase.rpc('claim_campaign_executions_fallback', {
    p_campaign_id: campaignId,
    p_limit: batchSize,
  });
}

function isWithinRunnerWindow(now: Date = new Date()): boolean {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: RUNNER_WINDOW_TIMEZONE,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(now);

  const hourPart = parts.find((part) => part.type === 'hour')?.value ?? '00';
  const minutePart = parts.find((part) => part.type === 'minute')?.value ?? '00';
  const totalMinutes = (Number(hourPart) * 60) + Number(minutePart);

  return totalMinutes >= RUNNER_WINDOW_START_HOUR * 60
    && totalMinutes < RUNNER_WINDOW_END_HOUR * 60;
}

export async function getCampaignExecutionWakeState(lastSeenVersion?: string | null) {
  const { data, error } = await supabase
    .from('campaigns')
    .select('updated_at')
    .not('updated_at', 'is', null)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    const code = String((error as any)?.code ?? '');
    const message = String((error as any)?.message ?? '');
    const missingUpdatedAt = code === '42703' || message.includes('campaigns.updated_at');

    if (missingUpdatedAt) {
      const migrationError: Error & { statusCode?: number } = new Error(
        'Campaign wake-check requires migration 20260512_add_campaigns_updated_at_for_wake_check.sql. Apply migration and restart backend.'
      );
      migrationError.statusCode = 503;
      throw migrationError;
    }

    throw error;
  }

  const version = String((data as any)?.updated_at ?? '0');
  const normalizedLastSeen = String(lastSeenVersion ?? '').trim();

  return {
    version,
    changed_since: normalizedLastSeen.length === 0 ? true : version !== normalizedLastSeen,
    within_window: isWithinRunnerWindow(),
    timezone: RUNNER_WINDOW_TIMEZONE,
    window_start: '09:00',
    window_end: '18:00',
  };
}

async function migratePendingLeadsToQueued(campaignId: string): Promise<number> {
  const { data: campaign, error: campaignError } = await supabase
    .from('campaigns')
    .select('status')
    .eq('id', campaignId)
    .maybeSingle();

  if (campaignError) throw campaignError;

  const campaignStatus = String((campaign as any)?.status ?? '').toLowerCase();
  if (campaignStatus !== 'running') {
    return 0;
  }

  const { data: updatedRows, error: updateError } = await supabase
    .from('campaign_leads')
    .update({
      status: 'queued',
      status_reason: 'migrated_from_pending_compat',
    })
    .eq('campaign_id', campaignId)
    .eq('status', 'pending')
    .select('id');

  if (updateError) {
    throw updateError;
  }

  return (updatedRows ?? []).length;
}

export async function getCampaignExecutionDiagnostics(campaignId: string) {
  const config = await getSendingLimitsConfig();
  const scheduleGate = isNowWithinSendingSchedule(config);
  const staleCutoffIso = new Date(
    Date.now() - (DEFAULT_STALE_PROCESSING_TIMEOUT_MINUTES * 60 * 1000)
  ).toISOString();

  const { data: campaign, error: campaignError } = await supabase
    .from('campaigns')
    .select('id,status,operator_id,sequence_id')
    .eq('id', campaignId)
    .maybeSingle();

  if (campaignError) throw campaignError;

  const [statusRowsResult, pausedRiskyResult, inboxesResult] = await Promise.all([
    supabase
      .from('campaign_leads')
      .select('status,processing_at')
      .eq('campaign_id', campaignId),
    supabase
      .from('campaign_leads')
      .select('id', { count: 'exact', head: true })
      .eq('campaign_id', campaignId)
      .eq('status', 'paused')
      .eq('status_reason', 'risky_daily_cap_reached'),
    supabase
      .from('campaign_inboxes')
      .select(`
        inbox_id,
        inboxes:inbox_id (
          id,
          is_paused
        )
      `)
      .eq('campaign_id', campaignId),
  ]);

  if (statusRowsResult.error) throw statusRowsResult.error;
  if (pausedRiskyResult.error) throw pausedRiskyResult.error;
  if (inboxesResult.error) throw inboxesResult.error;

  const counts: Record<string, number> = {
    queued: 0,
    processing: 0,
    paused: 0,
    sent: 0,
    failed: 0,
    replied: 0,
    pending: 0,
    completed: 0,
    other: 0,
  };
  let nullProcessingCount = 0;
  let staleProcessingCount = 0;
  let oldestProcessingAt: string | null = null;

  for (const row of statusRowsResult.data ?? []) {
    const status = String((row as any)?.status ?? '').toLowerCase();
    if (status in counts) counts[status] += 1;
    else counts.other += 1;

    if (status === 'processing') {
      const processingAtRaw = (row as any)?.processing_at ?? null;
      if (!processingAtRaw) {
        nullProcessingCount += 1;
        staleProcessingCount += 1;
        continue;
      }

      const processingAtIso = String(processingAtRaw);
      if (!oldestProcessingAt || processingAtIso < oldestProcessingAt) {
        oldestProcessingAt = processingAtIso;
      }
      if (processingAtIso < staleCutoffIso) {
        staleProcessingCount += 1;
      }
    }
  }

  const inboxRows = inboxesResult.data ?? [];
  const totalInboxes = inboxRows.length;
  const pausedInboxes = inboxRows.filter((r: any) => Boolean(r?.inboxes?.is_paused)).length;
  const activeInboxes = Math.max(0, totalInboxes - pausedInboxes);

  const claimHealth = await supabase.rpc('claim_campaign_executions', {
    p_campaign_id: campaignId,
    p_limit: 0,
  });

  const claimFunctionCallable = !claimHealth.error;
  const claimFunctionError = claimHealth.error
    ? String((claimHealth.error as any)?.message ?? 'unknown_error')
    : null;
  const allocator = await allocateCampaignSender({ campaignId });

  return {
    campaign: {
      id: campaignId,
      exists: Boolean(campaign),
      status: String((campaign as any)?.status ?? ''),
      operator_id: (campaign as any)?.operator_id ?? null,
      sequence_id: (campaign as any)?.sequence_id ?? null,
    },
    lead_counts: counts,
    schedule_gate: {
      allowed: scheduleGate.allowed,
      reason: scheduleGate.reason ?? null,
      timezone: config.schedule_timezone,
      allowed_weekdays: config.allowed_weekdays,
      send_window_start: config.send_window_start,
      send_window_end: config.send_window_end,
    },
    inboxes: {
      total: totalInboxes,
      active: activeInboxes,
      paused: pausedInboxes,
    },
    risky_cap_paused_count: Number(pausedRiskyResult.count ?? 0),
    processing_health: {
      timeout_minutes: DEFAULT_STALE_PROCESSING_TIMEOUT_MINUTES,
      cutoff_iso: staleCutoffIso,
      oldest_processing_at: oldestProcessingAt,
      null_processing_count: nullProcessingCount,
      stale_processing_count: staleProcessingCount,
      can_requeue_now: staleProcessingCount > 0,
    },
    claim_function: {
      callable: claimFunctionCallable,
      error: claimFunctionError,
    },
    allocator: {
      eligible_senders: allocator.eligible_count,
      blocked_by_reason: allocator.blocked_by_reason,
      selected_inbox_id: allocator.selected?.inbox_id ?? null,
      selected_domain_id: allocator.selected?.sending_domain_id ?? null,
      last_allocator_reason: allocator.reason,
      schedule_allowed: allocator.schedule_allowed,
      schedule_reason: allocator.schedule_reason,
      candidate_capacities: allocator.candidates.map((candidate) => ({
        inbox_id: candidate.inbox_id,
        domain_id: candidate.sending_domain_id,
        rem_daily_inbox: candidate.rem_daily_inbox,
        rem_hour_inbox: candidate.rem_hour_inbox,
        rem_daily_domain: candidate.rem_daily_domain,
        rem_hour_domain: candidate.rem_hour_domain,
      })),
    },
  };
}


  
  
export async function getNextCampaignExecutions(
  campaignId: string,
  batchSize: number
): Promise<ClaimExecutionResult> {
  const normalizedBatchSize = Number.isFinite(Number(batchSize))
    ? Math.max(0, Math.floor(Number(batchSize)))
    : 10;

  const migratedPendingCount = await migratePendingLeadsToQueued(campaignId);
  if (migratedPendingCount > 0) {
    console.info('[CLAIM_EXECUTIONS_PENDING_MIGRATED]', {
      campaign_id: campaignId,
      migrated_count: migratedPendingCount,
    });
  }

  const config = await getSendingLimitsConfig();
  const scheduleGate = isNowWithinSendingSchedule(config);
  if (!scheduleGate.allowed) {
    console.log('[CLAIM EXECUTIONS SKIPPED: SCHEDULE]', {
      campaign_id: campaignId,
      batch_size: normalizedBatchSize,
      reason: scheduleGate.reason ?? 'schedule_not_allowed',
    });
    return {
      executions: [],
      meta: {
        campaign_id: campaignId,
        batch_size: normalizedBatchSize,
        queued_count: 0,
        processing_count: 0,
        paused_count: 0,
        pending_count: 0,
        stale_requeued_count: 0,
        claimed_count: 0,
        reason: 'schedule_blocked',
        schedule_allowed: false,
        schedule_reason: scheduleGate.reason ?? 'schedule_not_allowed',
      },
    };
  }

  const staleRecovery = await requeueStaleProcessingLeads({
    campaignId,
    olderThanMinutes: DEFAULT_STALE_PROCESSING_TIMEOUT_MINUTES,
  });

  const [queuedCount, processingCount, pausedCount, pendingCount] = await Promise.all([
    countCampaignLeadsByStatus(campaignId, 'queued'),
    countCampaignLeadsByStatus(campaignId, 'processing'),
    countCampaignLeadsByStatus(campaignId, 'paused'),
    countCampaignLeadsByStatus(campaignId, 'pending'),
  ]);

  const { data, error } = await supabase.rpc(
    'claim_campaign_executions',
    {
      p_campaign_id: campaignId,
      p_limit: normalizedBatchSize,
    }
  );

  let claimPath: 'rpc' | 'fallback' = 'rpc';
  let executions = data ?? [];

  if (error) {
    const errorCode = String((error as any)?.code ?? '');
    const message = String((error as any)?.message ?? '').toLowerCase();
    const fnMissing =
      message.includes('claim_campaign_executions') &&
      (message.includes('does not exist') || message.includes('not exist'));
    const fnOverloaded =
      message.includes('could not choose the best candidate function') &&
      message.includes('claim_campaign_executions');
    const ambiguousIdReference = message.includes('column reference "id" is ambiguous');

    const shouldTryFallback = fnMissing || fnOverloaded || ambiguousIdReference;
    if (shouldTryFallback) {
      const fallback = await claimCampaignExecutionsViaFallback(campaignId, normalizedBatchSize);
      if (!fallback.error) {
        claimPath = 'fallback';
        executions = fallback.data ?? [];
        console.warn('[CLAIM EXECUTIONS FALLBACK USED]', {
          campaign_id: campaignId,
          batch_size: normalizedBatchSize,
          rpc_error_code: errorCode,
          rpc_error_message: String((error as any)?.message ?? ''),
          claimed_count: Array.isArray(executions) ? executions.length : 0,
        });
      } else {
        console.error('[CLAIM EXECUTIONS FALLBACK ERROR]', {
          campaign_id: campaignId,
          batch_size: normalizedBatchSize,
          rpc_error_code: errorCode,
          rpc_error_message: String((error as any)?.message ?? ''),
          fallback_error_code: String((fallback.error as any)?.code ?? ''),
          fallback_error_message: String((fallback.error as any)?.message ?? ''),
        });
      }
    }

    if (claimPath !== 'fallback') {
      if (fnMissing) {
        return {
          executions: [],
          meta: {
            campaign_id: campaignId,
            batch_size: normalizedBatchSize,
            queued_count: queuedCount,
            processing_count: processingCount,
            paused_count: pausedCount,
            pending_count: pendingCount,
            stale_requeued_count: staleRecovery.requeued,
            claimed_count: 0,
            reason: 'claim_function_unavailable',
            schedule_allowed: true,
            schedule_reason: null,
            claim_path: 'rpc',
          },
        };
      }
      if (fnOverloaded || ambiguousIdReference) {
        const migrationError: Error & { statusCode?: number } = new Error(
          'Claim RPC drift detected. Apply migration 20260521_claim_campaign_executions_ambiguous_id_fix_and_fallback.sql and restart backend.'
        );
        migrationError.statusCode = 503;
        throw migrationError;
      }

      console.error('[CLAIM EXECUTIONS ERROR]', {
        code: errorCode,
        message: String((error as any)?.message ?? ''),
        campaign_id: campaignId,
        batch_size: normalizedBatchSize,
      });
      throw error;
    }
  }

  const claimedCount = Array.isArray(executions) ? executions.length : 0;
  let reason: EmptyClaimReason | null = null;
  if (claimedCount === 0) {
    if (queuedCount === 0 && pendingCount === 0 && processingCount > 0) reason = 'all_processing';
    else if (queuedCount === 0 && pendingCount === 0 && pausedCount > 0) reason = 'all_paused';
    else if (queuedCount === 0 && pendingCount === 0) reason = 'no_queued_leads';
    else reason = 'no_claimable_rows';
  }

  console.log('[CLAIM EXECUTIONS DIAGNOSTICS]', {
    campaign_id: campaignId,
    batch_size: normalizedBatchSize,
    queued_count: queuedCount,
    processing_count: processingCount,
    paused_count: pausedCount,
    pending_count: pendingCount,
    stale_requeued_count: staleRecovery.requeued,
    claimed_count: claimedCount,
    reason,
    claim_path: claimPath,
  });

  return {
    executions,
    meta: {
      campaign_id: campaignId,
      batch_size: normalizedBatchSize,
      queued_count: queuedCount,
      processing_count: processingCount,
      paused_count: pausedCount,
      pending_count: pendingCount,
      stale_requeued_count: staleRecovery.requeued,
      claimed_count: claimedCount,
      reason,
      schedule_allowed: true,
      schedule_reason: null,
      claim_path: claimPath,
    },
  };
}

type RequeueStaleProcessingInput = {
  campaignId?: string;
  olderThanMinutes?: number;
};

export async function requeueStaleProcessingLeads(input: RequeueStaleProcessingInput = {}) {
  const campaignId = typeof input.campaignId === 'string' && input.campaignId.trim().length > 0
    ? input.campaignId.trim()
    : undefined;
  const requestedMinutes = Number(input.olderThanMinutes);
  const olderThanMinutes = Number.isFinite(requestedMinutes) && requestedMinutes > 0
    ? Math.floor(requestedMinutes)
    : DEFAULT_STALE_PROCESSING_TIMEOUT_MINUTES;

  const cutoffIso = new Date(Date.now() - (olderThanMinutes * 60 * 1000)).toISOString();

  let scopedQuery = supabase
    .from('campaign_leads')
    .select('id, campaign_id')
    .eq('status', 'processing')
    .or(`processing_at.lt.${cutoffIso},processing_at.is.null`);

  if (campaignId) {
    scopedQuery = scopedQuery.eq('campaign_id', campaignId);
  }

  let { data: staleRows, error: staleRowsError } = await scopedQuery;
  if (staleRowsError) {
    const message = String((staleRowsError as any)?.message ?? '');
    const code = String((staleRowsError as any)?.code ?? '');
    const missingProcessingAt = code === '42703' || message.includes('processing_at');

    // Backward compatibility: if older DB schema does not have processing_at,
    // skip stale requeue instead of breaking claim endpoint.
    if (missingProcessingAt) {
      console.warn('[REQUEUE STALE PROCESSING SKIPPED]', {
        reason: 'missing_processing_at_column',
        campaign_id: campaignId ?? null,
      });
      return {
        scanned: 0,
        requeued: 0,
        campaign_id: campaignId ?? null,
        older_than_minutes: olderThanMinutes,
        cutoff_iso: cutoffIso,
        skipped_reason: 'missing_processing_at_column',
      };
    }

    throw staleRowsError;
  }

  const staleIds = (staleRows ?? []).map((row: any) => String(row.id)).filter(Boolean);
  const scanned = staleIds.length;

  if (staleIds.length === 0) {
    return {
      scanned: 0,
      requeued: 0,
      campaign_id: campaignId ?? null,
      older_than_minutes: olderThanMinutes,
      cutoff_iso: cutoffIso,
    };
  }

  const { data: updatedRows, error: updateError } = await supabase
    .from('campaign_leads')
    .update({
      status: 'queued',
      status_reason: 'requeued_processing_timeout',
      execution_id: null,
      processing_at: null,
    })
    .in('id', staleIds)
    .eq('status', 'processing')
    .select('id');

  if (updateError) {
    throw updateError;
  }

  const requeued = (updatedRows ?? []).length;

  await supabase.from('system_events').insert({
    type: 'PROCESSING_REQUEUED_TIMEOUT',
    entity: 'campaign_leads',
    entity_id: campaignId ?? null,
    message: `Requeued ${requeued} stale processing lead(s).`,
    meta: {
      campaign_id: campaignId ?? null,
      scanned,
      requeued,
      older_than_minutes: olderThanMinutes,
      cutoff_iso: cutoffIso,
    },
  });

  return {
    scanned,
    requeued,
    campaign_id: campaignId ?? null,
    older_than_minutes: olderThanMinutes,
    cutoff_iso: cutoffIso,
  };
}


async function countCampaignLeadsByStatus(campaignId: string, status: string): Promise<number> {
  const { count, error } = await supabase
    .from('campaign_leads')
    .select('id', { count: 'exact', head: true })
    .eq('campaign_id', campaignId)
    .eq('status', status);

  if (error) {
    throw error;
  }

  return Number(count ?? 0);
}

/**
 * Send campaign email for ONE campaign_lead
 * Idempotent-safe, deterministic, RLS-safe
 */
export async function sendCampaignEmail(campaignLeadId: string) {
  const config = await getSendingLimitsConfig();
  const scheduleGate = isNowWithinSendingSchedule(config);
  if (!scheduleGate.allowed) {
    return {
      skipped: true,
      reason: scheduleGate.reason ?? 'schedule_not_allowed',
    };
  }

  const { data: campaignLead, error: leadError } = await supabase
    .from('campaign_leads')
    .select(`
      id,
      campaign_id,
      status,
      current_step,
      assigned_inbox_id,
      leads:lead_id (
        id,
        email,
        email_eligibility
      )
    `)
    .eq('id', campaignLeadId)
    .single();

  if (leadError || !campaignLead) {
    throw new Error('Campaign lead not found');
  }

  if (campaignLead.status !== 'processing') {
    throw new Error('Campaign lead is not in processing state');
  }

  const allocator = await allocateCampaignSender({
    campaignId: String((campaignLead as any).campaign_id ?? ''),
    leadEligibility: String((campaignLead as any)?.leads?.email_eligibility ?? ''),
  });

  if (!allocator.selected) {
    await supabase
      .from('campaign_leads')
      .update({
        status: 'queued',
        status_reason: allocator.reason || 'no_eligible_sender',
        processing_at: null,
        execution_id: null,
      })
      .eq('id', campaignLeadId)
      .eq('status', 'processing');

    await supabase.from('system_events').insert({
      type: 'CAMPAIGN_SEND_DEFERRED',
      entity: 'campaign_leads',
      entity_id: campaignLeadId,
      message: 'No eligible sender available; lead requeued for next tick.',
      meta: {
        campaign_id: (campaignLead as any).campaign_id ?? null,
        blocked_by_reason: allocator.blocked_by_reason,
        allocator_reason: allocator.reason,
      },
    });

    return {
      skipped: true,
      reason: allocator.reason || 'no_eligible_sender',
    };
  }

  const selectedInboxId = String(allocator.selected.inbox_id);
  if (String(campaignLead.assigned_inbox_id ?? '') !== selectedInboxId) {
    const { error: assignError } = await supabase
      .from('campaign_leads')
      .update({ assigned_inbox_id: selectedInboxId })
      .eq('id', campaignLeadId)
      .eq('status', 'processing');
    if (assignError) throw assignError;
    campaignLead.assigned_inbox_id = selectedInboxId;
  }

  const { data: inbox, error: inboxError } = await supabase
    .from('inboxes')
    .select(`
      id,
      email_address,
      smtp_account_id,
      sending_domain_id
    `)
    .eq('id', campaignLead.assigned_inbox_id)
    .single();

  if (inboxError || !inbox) {
    throw new Error('Inbox not found');
  }

  const { data: smtp, error: smtpError } = await supabase
    .from('smtp_accounts')
    .select(`
      provider,
      host,
      port,
      username,
      password,
      encryption
    `)
    .eq('id', inbox.smtp_account_id)
    .single();

  if (smtpError || !smtp) {
    throw new Error('SMTP account missing for inbox');
  }

  const { data: stepRow, error: stepError } = await supabase
    .from('campaign_leads')
    .select(`
      current_step,
      campaigns:campaign_id (
        sequences:sequence_id (
          sequence_steps (
            step_number,
            subject,
            body
          )
        )
      )
    `)
    .eq('id', campaignLeadId)
    .single();

  if (stepError || !stepRow) {
    throw new Error('Failed to load sequence');
  }

  const steps = stepRow.campaigns.sequences.sequence_steps;
  const step = steps.find((s: any) => s.step_number === stepRow.current_step);
  if (!step) {
    throw new Error('Sequence step not found');
  }

  const bodyRaw = String(step.body ?? '');
  const bodyLower = bodyRaw.toLowerCase();
  const blockedMarker = FORBIDDEN_SIGNOFF_MARKERS.find((marker) => bodyLower.includes(marker));
  if (blockedMarker && !bodyLower.includes('obaol team')) {
    throw new Error(`Content blocked: personal sign-off detected (${blockedMarker}). Use OBAOL Team signature.`);
  }

  const transporter = createSmtpTransport({
    provider: smtp.provider,
    host: smtp.host,
    port: smtp.port,
    username: smtp.username,
    password: decryptSecret(smtp.password),
    encryption: smtp.encryption,
  });

  const sentAtIso = new Date().toISOString();
  const pixelToken = makePixelToken({
    campaignLeadId: String(campaignLeadId),
    campaignId: String((campaignLead as any).campaign_id ?? ''),
    leadId: String((campaignLead as any)?.leads?.id ?? ''),
    toEmail: String((campaignLead as any)?.leads?.email ?? ''),
    sentAtIso,
  });
  const trackingBase = String(
    process.env.TRACKING_PIXEL_BASE_URL ||
    process.env.PUBLIC_BACKEND_URL ||
    process.env.BACKEND_PUBLIC_URL ||
    'https://emarketing-backend.infra.obaol.com'
  ).replace(/\/$/, '');
  const pixelHtml = `<img src="${trackingBase}/tracking/open/${pixelToken}" alt="" width="1" height="1" style="display:none;opacity:0;" />`;
  const htmlBody = `${renderPlainTextAsHtml(bodyRaw)}\n${pixelHtml}`;

  const info = await transporter.sendMail({
    from: `"${FIXED_CAMPAIGN_SENDER_NAME}" <${inbox.email_address}>`,
    to: campaignLead.leads.email,
    subject: step.subject,
    html: htmlBody,
  });

  await supabase.from('email_logs').insert({
    lead_id: campaignLead.leads.id,
    inbox_id: inbox.id,
    campaign_id: campaignLead.campaign_id,
    campaign_lead_id: campaignLeadId,
    to_email: campaignLead.leads.email,
    provider_name: String(smtp.provider ?? 'smtp'),
    provider_message_id: normalizeMessageId(info.messageId),
    subject: step.subject,
    body: bodyRaw,
    status: 'sent',
    sent_at: sentAtIso,
  });

  await supabase
    .from('inboxes')
    .update({ last_sent_at: new Date().toISOString() })
    .eq('id', inbox.id);

  await supabase.from('system_events').insert({
    type: 'email_sent',
    entity_id: campaignLeadId,
    meta: {
      message_id: info.messageId,
      inbox_id: inbox.id,
      domain_id: allocator.selected.sending_domain_id,
      to: campaignLead.leads.email,
    },
  });

  return {
    message_id: normalizeMessageId(info.messageId),
    to: campaignLead.leads.email,
  };
}

function normalizeMessageId(value: unknown): string {
  return String(value ?? '').trim().replace(/[<>]/g, '').toLowerCase();
}
/**
 * STEP SUCCESS
 */
export async function markCampaignLeadSent(
  campaignLeadId: string,
  reason: string = 'sent_successfully'
) {
  const { data, error } = await supabase
    .from('campaign_leads')
    .select('id, status, assigned_inbox_id, current_step')
    .eq('id', campaignLeadId)
    .single();

  if (error || !data) {
    throw new Error('Campaign lead not found');
  }

  if (data.status !== 'processing') {
    throw new Error('Campaign lead is not in processing state');
  }

  const inboxId = data.assigned_inbox_id;

  await supabase
    .from('campaign_leads')
    .update({
      status: 'completed',
      status_reason: reason,
      last_sent_at: new Date().toISOString(),
      current_step: data.current_step + 1,
    })
    .eq('id', campaignLeadId)
    .eq('status', 'processing');

  await supabase.from('system_events').insert({
    type: 'email_sent',
    entity_id: campaignLeadId,
    meta: { inbox_id: inboxId, reason },
  });
}




/**
 * STEP FAILURE
 */
export async function markCampaignLeadFailed(
  campaignLeadId: string,
  reason: string,
  code: string = 'unknown'
) {
  const { data, error } = await supabase
    .from('campaign_leads')
    .select('id, status, assigned_inbox_id')
    .eq('id', campaignLeadId)
    .single();

  if (error || !data) {
    throw new Error('Campaign lead not found');
  }

  if (data.status !== 'processing') {
    throw new Error('Campaign lead is not in processing state');
  }

  const inboxId = data.assigned_inbox_id;

  // 1️⃣ Update campaign lead
  await supabase
    .from('campaign_leads')
    .update({
      status: 'failed',
      status_reason: reason,
      status_code: code,
    })
    .eq('id', campaignLeadId)
    .eq('status', 'processing');

  // 2️⃣ Update inbox failure counters
  const { data: inbox } = await supabase
    .from('inboxes')
    .select('consecutive_failures')
    .eq('id', inboxId)
    .single();

  const newFailureCount = (inbox?.consecutive_failures ?? 0) + 1;

  const inboxUpdate: any = {
    failed_count: supabase.raw('failed_count + 1'),
    consecutive_failures: newFailureCount,
  };

  if (newFailureCount >= 3) {
    inboxUpdate.is_paused = true;
    inboxUpdate.paused_reason = 'Too many consecutive failures';
  }

  await supabase
    .from('inboxes')
    .update(inboxUpdate)
    .eq('id', inboxId);

  // 3️⃣ Log system event
  await supabase.from('system_events').insert({
    type: 'email_failed',
    entity_id: campaignLeadId,
    meta: {
      inbox_id: inboxId,
      status: 'failed',
      reason,
      code,
    },
  });
}


export async function completeCampaignIfDone(campaignId: string) {
  /**
   * 1. Load campaign + sequence length
   */
  const { data: campaign, error: campaignError } = await supabase
    .from('campaigns')
    .select(`
      id,
      status,
      sequences:sequence_id (
        sequence_steps (
          step_number
        )
      )
    `)
    .eq('id', campaignId)
    .single();

  if (campaignError || !campaign) {
    throw new Error('Campaign not found');
  }

  if (campaign.status !== 'running') {
    return false;
  }

  const steps = campaign.sequences.sequence_steps;
  const maxStep = Math.max(...steps.map((s: any) => s.step_number));

  /**
   * 2. Check if any leads still need execution
   */
  const { data: pendingLeads, error: leadError } = await supabase
    .from('campaign_leads')
    .select('id')
    .eq('campaign_id', campaignId)
    .in('status', ['queued', 'processing'])
    .limit(1);

  if (leadError) {
    throw leadError;
  }

  // If there are still active leads, campaign is NOT complete
  if (pendingLeads.length > 0) {
    return false;
  }

  /**
   * 3. Check if any lead still has steps remaining
   */
  const { data: incompleteSteps, error: stepError } = await supabase
    .from('campaign_leads')
    .select('id, current_step')
    .eq('campaign_id', campaignId)
    .lt('current_step', maxStep + 1)
    .not('status', 'in', '(failed,replied)')
    .limit(1);

  if (stepError) {
    throw stepError;
  }

  if (incompleteSteps.length > 0) {
    return false;
  }

  /**
   * 4. Mark campaign as completed
   */
  const { error: updateError } = await supabase
    .from('campaigns')
    .update({
      status: 'completed',
      completed_at: new Date().toISOString(),
    })
    .eq('id', campaignId)
    .eq('status', 'running');

  if (updateError) {
    throw updateError;
  }

  /**
   * 5. Log system event
   */
  await supabase.from('system_events').insert({
    type: 'campaign_completed',
    entity_id: campaignId,
  });

  return true;
}


export async function resetInboxCounters(
  resetHourly: boolean,
  resetDaily: boolean
) {
  const updates: any = {};

  if (resetHourly) {
    updates.hourly_send_count = 0;
  }

  if (resetDaily) {
    updates.daily_send_count = 0;
  }

  await supabase.from('inboxes').update(updates);
}

export async function requeueRiskyPausedLeads() {
  const { data: runningCampaigns, error: campaignError } = await supabase
    .from('campaigns')
    .select('id')
    .eq('status', 'running');

  if (campaignError) {
    throw campaignError;
  }

  const campaignIds = (runningCampaigns ?? []).map((row: any) => String(row.id)).filter(Boolean);
  if (campaignIds.length === 0) {
    return { updated: 0 };
  }

  const { data: pausedLeads, error: pausedLeadsError } = await supabase
    .from('campaign_leads')
    .select('id')
    .in('campaign_id', campaignIds)
    .eq('status', 'paused')
    .eq('status_reason', 'risky_daily_cap_reached');

  if (pausedLeadsError) {
    throw pausedLeadsError;
  }

  const leadIds = (pausedLeads ?? []).map((row: any) => String(row.id)).filter(Boolean);
  if (leadIds.length === 0) {
    return { updated: 0 };
  }

  const { error: updateError } = await supabase
    .from('campaign_leads')
    .update({
      status: 'queued',
      status_reason: null,
    })
    .in('id', leadIds);

  if (updateError) {
    throw updateError;
  }

  await supabase.from('system_events').insert({
    type: 'RISKY_REQUEUE_DAILY',
    entity: 'campaign_leads',
    message: `Daily risky-cap recovery requeued ${leadIds.length} lead(s).`,
    meta: {
      updated: leadIds.length,
      campaign_count: campaignIds.length,
    },
  });

  return { updated: leadIds.length };
}




/**
 * AUTO COMPLETE CAMPAIGN
 */
export async function maybeCompleteCampaign(campaignId: string) {
  const { count } = await supabase
    .from('campaign_leads')
    .select('*', { count: 'exact', head: true })
    .eq('campaign_id', campaignId)
    .in('status', ['queued', 'processing', 'paused']);

  if (count === 0) {
    await updateRow('campaigns', campaignId, {
      status: 'completed',
      completed_at: new Date().toISOString(),
    });

    await supabase.from('system_events').insert({
      type: 'campaign_completed',
      entity: 'campaign',
      entity_id: campaignId,
      message: 'Campaign completed automatically',
    });
  }
}






  type BounceType = 'hard' | 'soft' | 'reply';
  
  export async function handleBounce(
    email:string,
    type:'hard'|'soft',
    reason?:string
  ) {
    const { data: inbox } = await supabase
      .from('inboxes')
      .select('id,consecutive_failures')
      .eq('email_address',email)
      .single();
  
    if (!inbox) return;
  
    let updates:any = {
      failed_count: supabase.raw('failed_count + 1')
    };
  
    if (type === 'hard') {
      updates.is_paused = true;
      updates.paused_reason = 'Hard bounce';
    } else {
      updates.consecutive_failures = inbox.consecutive_failures + 1;
      if (updates.consecutive_failures >= 3) {
        updates.is_paused = true;
        updates.paused_reason = 'Repeated soft bounces';
      }
    }
  
    await supabase.from('inboxes').update(updates).eq('id', inbox.id);
  }
  
  export async function handleReply(payload:any) {
    const email = payload.from;
  
    await supabase
      .from('campaign_leads')
      .update({ status:'replied' })
      .eq('lead_email',email)
      .in('status',['queued','processing']);
  }
  

  
