import { supabase } from '../supabase';
import IORedis from 'ioredis';
import { decryptSecret } from '../utils/sendEncryption';
import { updateRow } from './crudService';
import { createSmtpTransport } from './email/smtpTransport';
import { renderPlainTextAsHtml } from './email/emailBodyRender';
import { makeClickToken, makePixelToken } from './emailTracking.service.js';
import { ingestInboundReply } from './replyIngestService.js';
import {
  getSendingLimitsConfig,
  isNowWithinSendingSchedule,
} from './sendingLimitsConfig.service';
import { allocateCampaignSender } from './sending/sendAllocator.service';
import { isCampaignMinuteBlocked, normalizeCampaignBatchSize } from './executionThrottle.utils.js';

const RUNNER_WINDOW_TIMEZONE = 'Asia/Kolkata';
const RUNNER_WINDOW_START_HOUR = 9;
const RUNNER_WINDOW_END_HOUR = 18;
const DEFAULT_STALE_PROCESSING_TIMEOUT_MINUTES = 10;
const FIXED_CAMPAIGN_SENDER_NAME = 'OBAOL Team';
const FORBIDDEN_SIGNOFF_MARKERS = ['regards, jacob', 'regards, joshua', 'joshua', 'jacob alwin joy', 'jacob supreme'];
const DELIVERABILITY_MINIMAL_TRACKING_ENABLED = String(process.env.DELIVERABILITY_MINIMAL_TRACKING_ENABLED ?? 'true').toLowerCase() === 'true';
const CAMPAIGN_MINUTE_LOCK_PREFIX = 'campaign-minute-lock';
const CAMPAIGN_MINUTE_LOCK_SAFETY_SECONDS = 2;
const LOCAL_LOCK_SWEEP_MS = 30_000;
const TEMP_UNDELIVERED_PAUSE_MS = 60 * 60 * 1000;
const TEMP_UNDELIVERED_PAUSE_REASON = 'temporary_pause_undelivered_1h';

let minuteLockRedis: IORedis | null | undefined;
const localMinuteLocks = new Map<string, number>();
let lastLocalLockSweepAt = 0;

type EmptyClaimReason =
  | 'schedule_blocked'
  | 'campaign_minute_throttled'
  | 'no_queued_leads'
  | 'all_processing'
  | 'all_paused'
  | 'claim_function_unavailable'
  | 'no_claimable_rows';

export type ClaimExecutionResult = {
  executions: any[];
  meta: {
    requested_batch_size: number;
    effective_batch_size: number;
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
    campaign_minute_gate?: {
      blocked: boolean;
      current_minute_window_start: string;
      sent_count_in_window: number;
    };
    rotation_next_inbox_id?: string | null;
    rotation_used_inbox_id?: string | null;
    rotation_fallback_used?: boolean;
    rotation_block_reason?: string | null;
  };
};

type RunBatchSkipReason =
  | 'schedule_blocked'
  | 'campaign_minute_throttled'
  | 'send_skipped'
  | 'send_skipped_unknown'
  | 'send_error';

export type CampaignBatchRunSummary = {
  requested_batch_size: number;
  effective_batch_size: number;
  campaign_id: string;
  batch_size: number;
  claimed_count: number;
  sent_count: number;
  failed_count: number;
  skipped_count: number;
  skip_reasons: Record<string, number>;
  queue_snapshot_before: {
    queued_count: number;
    processing_count: number;
    paused_count: number;
    pending_count: number;
  };
  queue_snapshot_after: {
    queued_count: number;
    processing_count: number;
    paused_count: number;
    pending_count: number;
  };
  did_complete_step_check: boolean;
  completed_step: boolean;
  stale_requeued_count: number;
  migrated_pending_count: number;
  claim_reason: string | null;
  claim_path: 'rpc' | 'fallback' | null;
  errors: Array<{
    campaign_lead_id: string | null;
    reason: string;
    detail?: string | null;
  }>;
  fatal_error: string | null;
};

type MinuteThrottleSource = 'claim' | 'send';
type MinuteThrottleBlockReason =
  | 'campaign_minute_throttled'
  | 'minute_lock_backend_unavailable'
  | 'minute_lock_acquire_error';
type MinuteThrottleGuardResult = {
  allowed: boolean;
  reason: MinuteThrottleBlockReason | null;
  minute_window_start: string;
  sent_count_in_window: number;
  lock_key: string | null;
  lock_backend: 'redis' | 'local_memory' | 'unavailable';
  lock_ttl_seconds: number | null;
};

function assertClaimRowsConformance(
  claimRows: any[],
  maxRows: number,
  context: { campaignId: string; claimPath: 'rpc' | 'fallback' }
): void {
  const rows = Array.isArray(claimRows) ? claimRows : [];
  if (rows.length > maxRows) {
    const migrationError: Error & { statusCode?: number } = new Error(
      `Claim path "${context.claimPath}" returned ${rows.length} rows (expected <= ${maxRows}) for campaign ${context.campaignId}. Fail-closed to prevent burst sends.`
    );
    migrationError.statusCode = 503;
    throw migrationError;
  }

  const ids = rows
    .map((row: any) => String(row?.campaign_lead_id ?? row?.id ?? '').trim())
    .filter(Boolean);
  const uniqueIds = new Set(ids);
  if (uniqueIds.size !== ids.length) {
    const migrationError: Error & { statusCode?: number } = new Error(
      `Claim path "${context.claimPath}" returned duplicate campaign lead ids for campaign ${context.campaignId}. Fail-closed to prevent duplicate send attempts.`
    );
    migrationError.statusCode = 503;
    throw migrationError;
  }
}

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

function currentMinuteWindowStartUtc(now: Date = new Date()): string {
  const floored = new Date(now);
  floored.setUTCSeconds(0, 0);
  return floored.toISOString();
}

async function getCampaignMinuteGate(campaignId: string): Promise<{
  blocked: boolean;
  minuteWindowStart: string;
  sentCountInWindow: number;
}> {
  const minuteWindowStart = currentMinuteWindowStartUtc();
  const { count, error } = await supabase
    .from('email_logs')
    .select('id', { count: 'exact', head: true })
    .eq('campaign_id', campaignId)
    .eq('status', 'sent')
    .gte('sent_at', minuteWindowStart);
  if (error) throw error;
  const sentCountInWindow = Number(count ?? 0);
  return {
    blocked: isCampaignMinuteBlocked(sentCountInWindow),
    minuteWindowStart,
    sentCountInWindow,
  };
}

function resolveMinuteLockRedis(): IORedis | null {
  if (minuteLockRedis !== undefined) return minuteLockRedis;
  const redisUrl = String(process.env.REDIS_URL ?? '').trim();
  if (!redisUrl) {
    minuteLockRedis = null;
    return minuteLockRedis;
  }

  minuteLockRedis = new IORedis(redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
  minuteLockRedis.on('error', (err: Error) => {
    console.warn('[CAMPAIGN_MINUTE_LOCK_REDIS_ERROR]', err.message);
  });
  return minuteLockRedis;
}

function isMinuteLockBackendConfigured(): boolean {
  return String(process.env.REDIS_URL ?? '').trim().length > 0;
}

function buildMinuteLockKey(campaignId: string, minuteWindowStartIso: string): string {
  return `${CAMPAIGN_MINUTE_LOCK_PREFIX}:${campaignId}:${minuteWindowStartIso}`;
}

function minuteLockTtlSeconds(now: Date = new Date()): number {
  const msIntoMinute = (now.getUTCSeconds() * 1000) + now.getUTCMilliseconds();
  const msRemaining = Math.max(1_000, 60_000 - msIntoMinute);
  return Math.max(2, Math.ceil(msRemaining / 1000) + CAMPAIGN_MINUTE_LOCK_SAFETY_SECONDS);
}

function sweepLocalMinuteLocks(nowMs: number): void {
  if (nowMs - lastLocalLockSweepAt < LOCAL_LOCK_SWEEP_MS) return;
  for (const [key, expiresAtMs] of localMinuteLocks.entries()) {
    if (expiresAtMs <= nowMs) localMinuteLocks.delete(key);
  }
  lastLocalLockSweepAt = nowMs;
}

async function acquireCampaignMinuteLock(campaignId: string): Promise<{
  acquired: boolean;
  minuteWindowStart: string;
  lock_key: string;
  lock_backend: 'redis' | 'local_memory';
  lock_ttl_seconds: number;
}> {
  const now = new Date();
  const minuteWindowStart = currentMinuteWindowStartUtc(now);
  const lockKey = buildMinuteLockKey(campaignId, minuteWindowStart);
  const lockTtlSeconds = minuteLockTtlSeconds(now);
  const lockClient = resolveMinuteLockRedis();

  if (lockClient) {
    const setResult = await lockClient.set(lockKey, String(Date.now()), 'EX', lockTtlSeconds, 'NX');
    return {
      acquired: setResult === 'OK',
      minuteWindowStart,
      lock_key: lockKey,
      lock_backend: 'redis',
      lock_ttl_seconds: lockTtlSeconds,
    };
  }

  const nowMs = Date.now();
  sweepLocalMinuteLocks(nowMs);
  const existingExpiry = localMinuteLocks.get(lockKey) ?? 0;
  if (existingExpiry > nowMs) {
    return {
      acquired: false,
      minuteWindowStart,
      lock_key: lockKey,
      lock_backend: 'local_memory',
      lock_ttl_seconds: lockTtlSeconds,
    };
  }
  localMinuteLocks.set(lockKey, nowMs + (lockTtlSeconds * 1000));
  return {
    acquired: true,
    minuteWindowStart,
    lock_key: lockKey,
    lock_backend: 'local_memory',
    lock_ttl_seconds: lockTtlSeconds,
  };
}

async function logCampaignMinuteThrottleEvent(input: {
  campaign_id: string;
  campaign_lead_id?: string | null;
  source: MinuteThrottleSource;
  reason: MinuteThrottleBlockReason;
  message: string;
  minute_window_start: string;
  sent_count_in_window: number;
  lock_key?: string | null;
  lock_backend?: 'redis' | 'local_memory' | 'unavailable';
  lock_ttl_seconds?: number | null;
}) {
  await supabase.from('system_events').insert({
    type: 'CAMPAIGN_MINUTE_THROTTLED',
    entity: 'campaigns',
    entity_id: input.campaign_id,
    message: input.message,
    meta: {
      campaign_id: input.campaign_id,
      campaign_lead_id: input.campaign_lead_id ?? null,
      source: input.source,
      blocked_reason: input.reason,
      minute_window_start: input.minute_window_start,
      sent_count_in_window: input.sent_count_in_window,
      lock_key: input.lock_key ?? null,
      lock_backend: input.lock_backend ?? 'unavailable',
      lock_ttl_seconds: input.lock_ttl_seconds ?? null,
    },
  });
}

async function enforceCampaignMinuteGuard(
  campaignId: string,
  source: MinuteThrottleSource,
  opts?: { campaignLeadId?: string | null; acquireLock?: boolean }
): Promise<MinuteThrottleGuardResult> {
  const acquireLock = opts?.acquireLock === true;
  const gate = await getCampaignMinuteGate(campaignId);

  if (acquireLock && !isMinuteLockBackendConfigured()) {
    await logCampaignMinuteThrottleEvent({
      campaign_id: campaignId,
      campaign_lead_id: opts?.campaignLeadId ?? null,
      source,
      reason: 'minute_lock_backend_unavailable',
      message: 'Send blocked: minute lock backend unavailable (REDIS_URL missing).',
      minute_window_start: gate.minuteWindowStart,
      sent_count_in_window: gate.sentCountInWindow,
      lock_backend: 'unavailable',
    });
    return {
      allowed: false,
      reason: 'minute_lock_backend_unavailable',
      minute_window_start: gate.minuteWindowStart,
      sent_count_in_window: gate.sentCountInWindow,
      lock_key: null,
      lock_backend: 'unavailable',
      lock_ttl_seconds: null,
    };
  }

  if (gate.blocked) {
    await logCampaignMinuteThrottleEvent({
      campaign_id: campaignId,
      campaign_lead_id: opts?.campaignLeadId ?? null,
      source,
      reason: 'campaign_minute_throttled',
      message: source === 'send'
        ? 'Send blocked by campaign minute gate at send-time.'
        : 'Claim blocked by campaign minute gate.',
      minute_window_start: gate.minuteWindowStart,
      sent_count_in_window: gate.sentCountInWindow,
      lock_backend: isMinuteLockBackendConfigured() ? 'redis' : 'unavailable',
    });
    return {
      allowed: false,
      reason: 'campaign_minute_throttled',
      minute_window_start: gate.minuteWindowStart,
      sent_count_in_window: gate.sentCountInWindow,
      lock_key: null,
      lock_backend: isMinuteLockBackendConfigured() ? 'redis' : 'unavailable',
      lock_ttl_seconds: null,
    };
  }

  if (!acquireLock) {
    return {
      allowed: true,
      reason: null,
      minute_window_start: gate.minuteWindowStart,
      sent_count_in_window: gate.sentCountInWindow,
      lock_key: null,
      lock_backend: isMinuteLockBackendConfigured() ? 'redis' : 'unavailable',
      lock_ttl_seconds: null,
    };
  }

  try {
    const minuteLock = await acquireCampaignMinuteLock(campaignId);
    if (!minuteLock.acquired) {
      const postLockGate = await getCampaignMinuteGate(campaignId);
      await logCampaignMinuteThrottleEvent({
        campaign_id: campaignId,
        campaign_lead_id: opts?.campaignLeadId ?? null,
        source,
        reason: 'campaign_minute_throttled',
        message: 'Send blocked by campaign minute lock (send-time guard).',
        minute_window_start: minuteLock.minuteWindowStart,
        sent_count_in_window: postLockGate.sentCountInWindow,
        lock_key: minuteLock.lock_key,
        lock_backend: minuteLock.lock_backend,
        lock_ttl_seconds: minuteLock.lock_ttl_seconds,
      });
      return {
        allowed: false,
        reason: 'campaign_minute_throttled',
        minute_window_start: minuteLock.minuteWindowStart,
        sent_count_in_window: postLockGate.sentCountInWindow,
        lock_key: minuteLock.lock_key,
        lock_backend: minuteLock.lock_backend,
        lock_ttl_seconds: minuteLock.lock_ttl_seconds,
      };
    }

    return {
      allowed: true,
      reason: null,
      minute_window_start: minuteLock.minuteWindowStart,
      sent_count_in_window: gate.sentCountInWindow,
      lock_key: minuteLock.lock_key,
      lock_backend: minuteLock.lock_backend,
      lock_ttl_seconds: minuteLock.lock_ttl_seconds,
    };
  } catch (err: any) {
    await logCampaignMinuteThrottleEvent({
      campaign_id: campaignId,
      campaign_lead_id: opts?.campaignLeadId ?? null,
      source,
      reason: 'minute_lock_acquire_error',
      message: `Send blocked: minute lock acquisition error (${String(err?.message ?? 'unknown_error')}).`,
      minute_window_start: gate.minuteWindowStart,
      sent_count_in_window: gate.sentCountInWindow,
      lock_backend: 'unavailable',
    });
    return {
      allowed: false,
      reason: 'minute_lock_acquire_error',
      minute_window_start: gate.minuteWindowStart,
      sent_count_in_window: gate.sentCountInWindow,
      lock_key: null,
      lock_backend: 'unavailable',
      lock_ttl_seconds: null,
    };
  }
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
          is_paused,
          paused_until
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
  const nowIso = new Date().toISOString();
  const pausedInboxes = inboxRows.filter((r: any) => Boolean(r?.inboxes?.is_paused)).length;
  const tempPausedInboxes = inboxRows.filter((r: any) => {
    const pausedUntilRaw = String(r?.inboxes?.paused_until ?? '').trim();
    return pausedUntilRaw.length > 0 && pausedUntilRaw > nowIso;
  }).length;
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
  const minuteGate = await getCampaignMinuteGate(campaignId);
  const burstWindowStartIso = new Date(Date.now() - (24 * 60 * 60 * 1000)).toISOString();
  const { data: sentRowsLast24h, error: sentRowsLast24hError } = await supabase
    .from('email_logs')
    .select('sent_at')
    .eq('campaign_id', campaignId)
    .eq('status', 'sent')
    .gte('sent_at', burstWindowStartIso);
  if (sentRowsLast24hError) throw sentRowsLast24hError;
  const minuteBuckets = new Map<string, number>();
  for (const row of sentRowsLast24h ?? []) {
    const sentAtRaw = String((row as any)?.sent_at ?? '').trim();
    if (!sentAtRaw) continue;
    const sentAt = new Date(sentAtRaw);
    if (Number.isNaN(sentAt.getTime())) continue;
    sentAt.setUTCSeconds(0, 0);
    const bucket = sentAt.toISOString();
    minuteBuckets.set(bucket, Number(minuteBuckets.get(bucket) ?? 0) + 1);
  }
  const burstViolations = Array.from(minuteBuckets.entries())
    .filter(([, count]) => count > 1)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([minute_start_utc, sent_count]) => ({ minute_start_utc, sent_count }));
  const { count: minuteThrottleEventsCount, error: minuteThrottleEventsError } = await supabase
    .from('system_events')
    .select('id', { count: 'exact', head: true })
    .eq('type', 'CAMPAIGN_MINUTE_THROTTLED')
    .eq('entity_id', campaignId);
  if (minuteThrottleEventsError) throw minuteThrottleEventsError;
  const { data: lastMinuteThrottleEvent, error: lastMinuteThrottleEventError } = await supabase
    .from('system_events')
    .select('created_at')
    .eq('type', 'CAMPAIGN_MINUTE_THROTTLED')
    .eq('entity_id', campaignId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (lastMinuteThrottleEventError) throw lastMinuteThrottleEventError;
  const next_actions: string[] = [];
  if (!scheduleGate.allowed) {
    next_actions.push(`Wait for sending window: ${scheduleGate.reason ?? 'outside_allowed_schedule'}`);
  }
  if (counts.queued === 0 && counts.pending > 0) {
    next_actions.push('No queued leads yet; verify pending->queued migration conditions and campaign status.');
  }
  if (staleProcessingCount > 0) {
    next_actions.push('Run stale processing recovery; leads appear stuck in processing.');
  }
  if (pausedInboxes > 0 && activeInboxes === 0) {
    next_actions.push('All assigned inboxes are paused; unpause an inbox or assign a healthy inbox.');
  }
  if ((allocator.blocked_by_reason?.inbox_temp_paused_until ?? 0) > 0) {
    next_actions.push('One or more inboxes are in 1-hour temporary cooldown due to undelivered outcomes.');
  }
  if (!allocator.selected) {
    next_actions.push(`Allocator blocked sending: ${allocator.reason || 'no_eligible_sender'}.`);
  }
  if (minuteGate.blocked) {
    next_actions.push('Campaign minute throttle active: one send already done in current UTC minute window.');
  }
  if (burstViolations.length > 0) {
    next_actions.push('Burst invariant violated: found >1 sent email in a minute bucket for this campaign. Investigate immediately.');
  }
  if (next_actions.length === 0) {
    next_actions.push('No immediate blockers detected; run batch execution and inspect per-lead outcomes.');
  }

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
      temp_paused: tempPausedInboxes,
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
      rotation_next_inbox_id: allocator.rotation_next_inbox_id,
      rotation_used_inbox_id: allocator.rotation_used_inbox_id,
      rotation_fallback_used: allocator.rotation_fallback_used,
      rotation_block_reason: allocator.rotation_block_reason,
      schedule_allowed: allocator.schedule_allowed,
      schedule_reason: allocator.schedule_reason,
      candidate_capacities: allocator.candidates.map((candidate) => ({
        inbox_id: candidate.inbox_id,
        domain_id: candidate.sending_domain_id,
        paused_until: candidate.paused_until,
        rem_daily_inbox: candidate.rem_daily_inbox,
        rem_hour_inbox: candidate.rem_hour_inbox,
        rem_daily_domain: candidate.rem_daily_domain,
        rem_hour_domain: candidate.rem_hour_domain,
      })),
    },
    campaign_minute_gate: {
      blocked: minuteGate.blocked,
      current_minute_window_start: minuteGate.minuteWindowStart,
      sent_count_in_window: minuteGate.sentCountInWindow,
      throttle_hit_count: Number(minuteThrottleEventsCount ?? 0),
      last_throttle_at: String((lastMinuteThrottleEvent as any)?.created_at ?? '') || null,
      active_runner_path: 'backend_run_batch_primary',
    },
    no_burst_proof: {
      evaluated_window_start: burstWindowStartIso,
      evaluated_window_end: new Date().toISOString(),
      burst_violation_count_last_24h: burstViolations.length,
      burst_violations_last_24h: burstViolations,
    },
    diagnostics_assertions: {
      one_email_per_minute_campaign_invariant: {
        passed: burstViolations.length === 0,
        violation_count: burstViolations.length,
      },
    },
    next_actions,
  };
}

function bumpReason(counter: Record<string, number>, reason: string) {
  const key = reason.trim().length > 0 ? reason : 'unknown';
  counter[key] = Number(counter[key] ?? 0) + 1;
}

export async function runCampaignExecutionBatch(
  campaignId: string,
  batchSize: number
): Promise<CampaignBatchRunSummary> {
  const batchShape = normalizeCampaignBatchSize(batchSize);
  const requestedBatchSize = batchShape.requested_batch_size;
  const normalizedBatchSize = batchShape.effective_batch_size;

  const summary: CampaignBatchRunSummary = {
    requested_batch_size: requestedBatchSize,
    effective_batch_size: normalizedBatchSize,
    campaign_id: campaignId,
    batch_size: normalizedBatchSize,
    claimed_count: 0,
    sent_count: 0,
    failed_count: 0,
    skipped_count: 0,
    skip_reasons: {},
    queue_snapshot_before: {
      queued_count: 0,
      processing_count: 0,
      paused_count: 0,
      pending_count: 0,
    },
    queue_snapshot_after: {
      queued_count: 0,
      processing_count: 0,
      paused_count: 0,
      pending_count: 0,
    },
    did_complete_step_check: false,
    completed_step: false,
    stale_requeued_count: 0,
    migrated_pending_count: 0,
    claim_reason: null,
    claim_path: null,
    errors: [],
    fatal_error: null,
  };

  try {
    const [queuedBefore, processingBefore, pausedBefore, pendingBefore] = await Promise.all([
      countCampaignLeadsByStatus(campaignId, 'queued'),
      countCampaignLeadsByStatus(campaignId, 'processing'),
      countCampaignLeadsByStatus(campaignId, 'paused'),
      countCampaignLeadsByStatus(campaignId, 'pending'),
    ]);
    summary.queue_snapshot_before = {
      queued_count: queuedBefore,
      processing_count: processingBefore,
      paused_count: pausedBefore,
      pending_count: pendingBefore,
    };

    const migratedPendingCount = await migratePendingLeadsToQueued(campaignId);
    summary.migrated_pending_count = migratedPendingCount;

    const staleRecovery = await requeueStaleProcessingLeads({
      campaignId,
      olderThanMinutes: DEFAULT_STALE_PROCESSING_TIMEOUT_MINUTES,
    });
    summary.stale_requeued_count = Number(staleRecovery?.requeued ?? 0);

    const claim = await getNextCampaignExecutions(campaignId, normalizedBatchSize);
    const executions = Array.isArray(claim.executions) ? claim.executions : [];
    summary.claimed_count = executions.length;
    summary.claim_reason = claim.meta.reason ?? null;
    summary.claim_path = claim.meta.claim_path ?? null;

    if (!claim.meta.schedule_allowed) {
      summary.skipped_count = summary.claimed_count;
      bumpReason(summary.skip_reasons, 'schedule_blocked');
    }

    for (const execution of executions) {
      const campaignLeadId = String((execution as any)?.campaign_lead_id ?? (execution as any)?.id ?? '').trim();
      if (!campaignLeadId) {
        summary.failed_count += 1;
        summary.errors.push({
          campaign_lead_id: null,
          reason: 'invalid_claim_row',
          detail: 'Claim row missing campaign_lead_id',
        });
        continue;
      }

      try {
        const sendResult: any = await sendCampaignEmail(campaignLeadId);
        if (sendResult?.skipped === true) {
          const skipReason = String(sendResult?.reason ?? 'send_skipped_unknown') as RunBatchSkipReason;
          summary.skipped_count += 1;
          bumpReason(summary.skip_reasons, skipReason);
          continue;
        }

        await markCampaignLeadSent(campaignLeadId, 'batch_sent_successfully');
        summary.sent_count += 1;
      } catch (err: any) {
        const reason = String(err?.message ?? 'send_error');
        try {
          await markCampaignLeadFailed(campaignLeadId, reason, 'run_batch_send_failed');
        } catch (markErr: any) {
          summary.errors.push({
            campaign_lead_id: campaignLeadId,
            reason: 'mark_failed_error',
            detail: String(markErr?.message ?? 'failed to mark failed'),
          });
        }
        summary.failed_count += 1;
        bumpReason(summary.skip_reasons, 'send_error');
        summary.errors.push({
          campaign_lead_id: campaignLeadId,
          reason: 'send_error',
          detail: reason,
        });
      }
    }

    summary.did_complete_step_check = true;
    summary.completed_step = await completeCampaignIfDone(campaignId);

    const [queuedAfter, processingAfter, pausedAfter, pendingAfter] = await Promise.all([
      countCampaignLeadsByStatus(campaignId, 'queued'),
      countCampaignLeadsByStatus(campaignId, 'processing'),
      countCampaignLeadsByStatus(campaignId, 'paused'),
      countCampaignLeadsByStatus(campaignId, 'pending'),
    ]);
    summary.queue_snapshot_after = {
      queued_count: queuedAfter,
      processing_count: processingAfter,
      paused_count: pausedAfter,
      pending_count: pendingAfter,
    };

    await supabase.from('system_events').insert({
      type: 'CAMPAIGN_BATCH_EXECUTED',
      entity: 'campaigns',
      entity_id: campaignId,
      message: `Batch run claimed=${summary.claimed_count}, sent=${summary.sent_count}, failed=${summary.failed_count}, skipped=${summary.skipped_count}`,
      meta: summary,
    });
  } catch (err: any) {
    summary.fatal_error = String(err?.message ?? 'run_batch_failed');
    await supabase.from('system_events').insert({
      type: 'CAMPAIGN_BATCH_EXECUTION_FATAL',
      entity: 'campaigns',
      entity_id: campaignId,
      message: summary.fatal_error,
      meta: {
        campaign_id: campaignId,
        batch_size: normalizedBatchSize,
      },
    });
  }

  return summary;
}


  
  
export async function getNextCampaignExecutions(
  campaignId: string,
  batchSize: number
): Promise<ClaimExecutionResult> {
  const batchShape = normalizeCampaignBatchSize(batchSize);
  const requestedBatchSize = batchShape.requested_batch_size;
  const normalizedBatchSize = batchShape.effective_batch_size;

  const migratedPendingCount = await migratePendingLeadsToQueued(campaignId);
  if (migratedPendingCount > 0) {
    console.info('[CLAIM_EXECUTIONS_PENDING_MIGRATED]', {
      campaign_id: campaignId,
      migrated_count: migratedPendingCount,
    });
  }

  const config = await getSendingLimitsConfig();
  const scheduleGate = isNowWithinSendingSchedule(config);
  const minuteGate = await getCampaignMinuteGate(campaignId);
  if (!scheduleGate.allowed) {
    console.log('[CLAIM EXECUTIONS SKIPPED: SCHEDULE]', {
      campaign_id: campaignId,
      batch_size: normalizedBatchSize,
      reason: scheduleGate.reason ?? 'schedule_not_allowed',
    });
    return {
      executions: [],
      meta: {
        requested_batch_size: requestedBatchSize,
        effective_batch_size: normalizedBatchSize,
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
        campaign_minute_gate: {
          blocked: minuteGate.blocked,
          current_minute_window_start: minuteGate.minuteWindowStart,
          sent_count_in_window: minuteGate.sentCountInWindow,
        },
        rotation_next_inbox_id: null,
        rotation_used_inbox_id: null,
        rotation_fallback_used: false,
        rotation_block_reason: null,
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
  const allocatorPreview = await allocateCampaignSender({ campaignId });

  const minuteGuard = await enforceCampaignMinuteGuard(campaignId, 'claim', { acquireLock: false });
  if (!minuteGuard.allowed) {
    return {
      executions: [],
      meta: {
        requested_batch_size: requestedBatchSize,
        effective_batch_size: normalizedBatchSize,
        campaign_id: campaignId,
        batch_size: normalizedBatchSize,
        queued_count: queuedCount,
        processing_count: processingCount,
        paused_count: pausedCount,
        pending_count: pendingCount,
        stale_requeued_count: staleRecovery.requeued,
        claimed_count: 0,
        reason: 'campaign_minute_throttled',
        schedule_allowed: true,
        schedule_reason: null,
        claim_path: 'rpc',
        campaign_minute_gate: {
          blocked: true,
          current_minute_window_start: minuteGuard.minute_window_start,
          sent_count_in_window: minuteGuard.sent_count_in_window,
        },
        rotation_next_inbox_id: allocatorPreview.rotation_next_inbox_id,
        rotation_used_inbox_id: allocatorPreview.rotation_used_inbox_id,
        rotation_fallback_used: allocatorPreview.rotation_fallback_used,
        rotation_block_reason: allocatorPreview.rotation_block_reason,
      },
    };
  }

  const { data, error } = await supabase.rpc(
    'claim_campaign_executions',
    {
      p_campaign_id: campaignId,
      p_limit: normalizedBatchSize,
    }
  );

  let claimPath: 'rpc' | 'fallback' = 'rpc';
  let executions = data ?? [];
  assertClaimRowsConformance(executions, normalizedBatchSize, {
    campaignId,
    claimPath: 'rpc',
  });

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
        assertClaimRowsConformance(fallback.data ?? [], normalizedBatchSize, {
          campaignId,
          claimPath: 'fallback',
        });
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
        const migrationError: Error & { statusCode?: number } = new Error(
          'Claim fallback path unavailable or non-conforming. Apply claim fallback migration and restart backend (fail-closed to enforce 1 email/minute).'
        );
        migrationError.statusCode = 503;
        throw migrationError;
      }
    }

    if (claimPath !== 'fallback') {
      if (fnMissing) {
        return {
          executions: [],
          meta: {
            requested_batch_size: requestedBatchSize,
            effective_batch_size: normalizedBatchSize,
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
            campaign_minute_gate: {
              blocked: false,
              current_minute_window_start: minuteGate.minuteWindowStart,
              sent_count_in_window: minuteGate.sentCountInWindow,
            },
            rotation_next_inbox_id: allocatorPreview.rotation_next_inbox_id,
            rotation_used_inbox_id: allocatorPreview.rotation_used_inbox_id,
            rotation_fallback_used: allocatorPreview.rotation_fallback_used,
            rotation_block_reason: allocatorPreview.rotation_block_reason,
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
    requested_batch_size: requestedBatchSize,
    effective_batch_size: normalizedBatchSize,
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
      requested_batch_size: requestedBatchSize,
      effective_batch_size: normalizedBatchSize,
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
      campaign_minute_gate: {
        blocked: false,
        current_minute_window_start: minuteGate.minuteWindowStart,
        sent_count_in_window: minuteGate.sentCountInWindow,
      },
      rotation_next_inbox_id: allocatorPreview.rotation_next_inbox_id,
      rotation_used_inbox_id: allocatorPreview.rotation_used_inbox_id,
      rotation_fallback_used: allocatorPreview.rotation_fallback_used,
      rotation_block_reason: allocatorPreview.rotation_block_reason,
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
      campaigns:campaign_id (
        sender_display_name
      ),
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

  const campaignId = String((campaignLead as any).campaign_id ?? '');
  const minuteGuard = await enforceCampaignMinuteGuard(campaignId, 'send', {
    campaignLeadId,
    acquireLock: true,
  });
  if (!minuteGuard.allowed) {
    return {
      skipped: true,
      reason: minuteGuard.reason ?? 'campaign_minute_throttled',
    };
  }

  const allocator = await allocateCampaignSender({
    campaignId,
    leadEligibility: String((campaignLead as any)?.leads?.email_eligibility ?? ''),
    recipientEmail: String((campaignLead as any)?.leads?.email ?? ''),
    firstTouch: Number((campaignLead as any)?.current_step ?? 1) <= 1,
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
        rotation_next_inbox_id: allocator.rotation_next_inbox_id,
        rotation_used_inbox_id: allocator.rotation_used_inbox_id,
        rotation_fallback_used: allocator.rotation_fallback_used,
        rotation_block_reason: allocator.rotation_block_reason,
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
  const personalSignoffWarning = blockedMarker && !bodyLower.includes('obaol team')
    ? `Personal sign-off detected (${blockedMarker}). Recommended: OBAOL Team signature.`
    : null;

  const transporter = createSmtpTransport({
    provider: smtp.provider,
    host: smtp.host,
    port: smtp.port,
    username: smtp.username,
    password: decryptSecret(smtp.password),
    encryption: smtp.encryption,
  });

  const sentAtIso = new Date().toISOString();
  const recipientEmail = String((campaignLead as any)?.leads?.email ?? '').trim().toLowerCase();
  const recipientDomain = recipientEmail.includes('@') ? recipientEmail.split('@').pop() ?? '' : '';
  const isMicrosoftRecipient = /(?:^|\.)(outlook\.com|hotmail\.com|live\.com|msn\.com)$/i.test(recipientDomain);
  const isFirstTouch = Number((campaignLead as any)?.current_step ?? 1) <= 1;
  const minimalTrackingMode = DELIVERABILITY_MINIMAL_TRACKING_ENABLED && isMicrosoftRecipient && isFirstTouch;
  const trackingBase = resolveTrackingBaseUrl();
  const renderedBody = renderPlainTextAsHtml(bodyRaw);
  const trackedBody = minimalTrackingMode
    ? renderedBody
    : withTrackedLinks(renderedBody, {
        campaignLeadId: String(campaignLeadId),
        campaignId: String((campaignLead as any).campaign_id ?? ''),
        leadId: String((campaignLead as any)?.leads?.id ?? ''),
        toEmail: String((campaignLead as any)?.leads?.email ?? ''),
        sentAtIso,
        trackingBase,
      });
  const pixelHtml = minimalTrackingMode
    ? ''
    : (() => {
        const pixelToken = makePixelToken({
          campaignLeadId: String(campaignLeadId),
          campaignId: String((campaignLead as any).campaign_id ?? ''),
          leadId: String((campaignLead as any)?.leads?.id ?? ''),
          toEmail: String((campaignLead as any)?.leads?.email ?? ''),
          sentAtIso,
        });
        return `<img src="${trackingBase}/tracking/open/${pixelToken}" alt="" width="1" height="1" style="display:none;opacity:0;" />`;
      })();
  const htmlBody = wrapCampaignHtmlBody(pixelHtml ? `${trackedBody}\n${pixelHtml}` : trackedBody);

  const campaignSenderDisplayName = String((campaignLead as any)?.campaigns?.sender_display_name ?? '').trim();
  const effectiveSenderDisplayName = campaignSenderDisplayName || FIXED_CAMPAIGN_SENDER_NAME;

  const info = await transporter.sendMail({
    from: `"${effectiveSenderDisplayName}" <${inbox.email_address}>`,
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
      sender_display_name: effectiveSenderDisplayName,
      personal_signoff_warning: personalSignoffWarning,
      deliverability_mode: minimalTrackingMode ? 'minimal_tracking' : 'standard_tracking',
      rotation_next_inbox_id: allocator.rotation_next_inbox_id,
      rotation_used_inbox_id: allocator.rotation_used_inbox_id,
      rotation_fallback_used: allocator.rotation_fallback_used,
      rotation_block_reason: allocator.rotation_block_reason,
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

function resolveTrackingBaseUrl(): string {
  const configured = String(
    process.env.TRACKING_PIXEL_BASE_URL ||
    process.env.PUBLIC_BACKEND_URL ||
    process.env.BACKEND_PUBLIC_URL ||
    'https://emarketing-backend.infra.obaol.com'
  ).trim();
  const sanitized = configured.replace(/\/$/, '');
  if (/^http:\/\//i.test(sanitized) && !/localhost|127\.0\.0\.1/i.test(sanitized)) {
    return sanitized.replace(/^http:\/\//i, 'https://');
  }
  return sanitized;
}

function withTrackedLinks(
  html: string,
  context: {
    campaignLeadId: string;
    campaignId: string;
    leadId: string;
    toEmail: string;
    sentAtIso: string;
    trackingBase: string;
  }
): string {
  const urlRegex = /(https?:\/\/[^\s<]+)/gi;
  return html.replace(urlRegex, (rawUrl: string) => {
    const normalizedUrl = rawUrl.trim().replace(/[),.;!?]+$/g, '');
    let parsed: URL;
    try {
      parsed = new URL(normalizedUrl);
    } catch {
      return rawUrl;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return rawUrl;
    const token = makeClickToken({
      campaignLeadId: context.campaignLeadId,
      campaignId: context.campaignId,
      leadId: context.leadId,
      toEmail: context.toEmail,
      sentAtIso: context.sentAtIso,
      redirectUrl: parsed.toString(),
    });
    const trackedHref = `${context.trackingBase}/tracking/click/${token}`;
    return `<a href="${trackedHref}" target="_blank" rel="noopener noreferrer">${normalizedUrl}</a>`;
  });
}

function wrapCampaignHtmlBody(contentHtml: string): string {
  return [
    '<!doctype html>',
    '<html>',
    '<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>',
    '<body style="margin:0;padding:0;background:#ffffff;color:#111827;font-family:Arial,Helvetica,sans-serif;">',
    '<div style="max-width:680px;margin:0 auto;padding:12px 16px;line-height:1.55;font-size:16px;">',
    contentHtml,
    '</div>',
    '</body>',
    '</html>',
  ].join('');
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
  const tempPauseUntilIso = new Date(Date.now() + TEMP_UNDELIVERED_PAUSE_MS).toISOString();

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
    paused_until: tempPauseUntilIso,
    paused_reason: TEMP_UNDELIVERED_PAUSE_REASON,
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
  const tempPauseUntilIso = new Date(Date.now() + TEMP_UNDELIVERED_PAUSE_MS).toISOString();
  
  let updates:any = {
      failed_count: supabase.raw('failed_count + 1'),
      paused_until: tempPauseUntilIso,
      paused_reason: TEMP_UNDELIVERED_PAUSE_REASON,
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
    await ingestInboundReply({
      from_email: payload?.from ?? payload?.from_email,
      message: payload?.message,
      inbox_email: payload?.inbox_email,
      message_id: payload?.message_id,
      received_at: payload?.received_at,
      leadId: payload?.leadId,
      source: 'manual_api',
    });
  }
  

  
