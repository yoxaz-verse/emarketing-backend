import { supabase } from '../supabase';
import { getSendingLimitsConfig, resolveInboxEffectiveLimits } from './sendingLimitsConfig.service';
import type { Role } from '../auth/roles';

export type OperationsSummaryResponse = {
  campaigns: {
    total: number;
    running: number;
    paused: number;
    draft: number;
  };
  inboxes: {
    total: number;
    active: number;
    in_use: number;
    idle: number;
    paused: number;
    hard_paused: number;
  };
  capacity: {
    total_daily_capacity: number;
    in_use_daily_capacity: number;
    idle_daily_capacity: number;
  };
  leads: {
    total: number;
    free_send_ready: number;
    used: number;
    blocked_or_failed: number;
  };
  replies: {
    total_replied: number;
    replied_last_7d: number;
    unreviewed_replies: number;
    interested_replies: number;
  };
  health: {
    inboxes_needing_attention: number;
  };
};

type InboxRow = {
  id: string;
  status: string | null;
  is_paused: boolean | null;
  hard_paused: boolean | null;
  health_score: number | null;
  daily_limit: number | null;
  hourly_limit: number | null;
  warmup_enabled: boolean | null;
  warmup_day: number | null;
};

type CampaignRow = {
  id: string;
  status: string | null;
  operator_id?: string | null;
};

type CampaignInboxRow = {
  campaign_id: string;
  inbox_id: string;
};

type LeadRow = {
  id: string;
  is_used: boolean | null;
  email_eligibility: string | null;
  permanently_failed: boolean | null;
  is_suppressed: boolean | null;
  status: string | null;
  replied_at: string | null;
  interest_status: string | null;
};

type AuthContext = {
  type: 'user' | 'api';
  role: Role;
  user_id?: string;
  operator_id?: string | null;
  api_key_id?: string;
};

function toSafeNumber(value: unknown, fallback = 0): number {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return num;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && error !== null && 'message' in error) {
    return String((error as { message?: unknown }).message ?? 'Unknown error');
  }
  return String(error ?? 'Unknown error');
}

export async function getOperationsSummary(auth?: AuthContext): Promise<OperationsSummaryResponse> {
  let sendingLimits: any;
  try {
    sendingLimits = await getSendingLimitsConfig();
  } catch {
    sendingLimits = {
      min_inbox_health_score: 60,
      warmup_steps: [],
    };
  }

  const normalizedRole = String(auth?.role ?? '').toLowerCase();
  const scopedOperatorId =
    normalizedRole === 'admin' || normalizedRole === 'superadmin'
      ? null
      : String(auth?.operator_id ?? '').trim() || null;

  let campaignsQuery = supabase.from('campaigns').select('id,status,operator_id');
  if (scopedOperatorId) {
    campaignsQuery = campaignsQuery.eq('operator_id', scopedOperatorId);
  }
  const campaignsResult = await campaignsQuery;

  const campaigns = (campaignsResult.data ?? []) as CampaignRow[];
  const scopedCampaignIds = campaigns.map((campaign) => String(campaign.id));

  let campaignInboxesQuery = supabase.from('campaign_inboxes').select('campaign_id,inbox_id');
  if (scopedCampaignIds.length > 0) {
    campaignInboxesQuery = campaignInboxesQuery.in('campaign_id', scopedCampaignIds);
  } else if (scopedOperatorId) {
    campaignInboxesQuery = campaignInboxesQuery.eq('campaign_id', '__none__');
  }
  const campaignInboxesResult = await campaignInboxesQuery;

  const scopedInboxIds = Array.from(
    new Set((campaignInboxesResult.data ?? []).map((row: CampaignInboxRow) => String(row.inbox_id)))
  );

  let inboxesFullQuery = supabase
    .from('inboxes')
    .select('id,status,is_paused,hard_paused,health_score,daily_limit,hourly_limit,warmup_enabled,warmup_day');
  if (scopedOperatorId) {
    if (scopedInboxIds.length > 0) {
      inboxesFullQuery = inboxesFullQuery.in('id', scopedInboxIds);
    } else {
      inboxesFullQuery = inboxesFullQuery.eq('id', '__none__');
    }
  }
  const inboxesFullResult = await inboxesFullQuery;

  let inboxesFallbackQuery = supabase.from('inboxes').select('id,status,is_paused,health_score,daily_limit,hourly_limit');
  if (scopedOperatorId) {
    if (scopedInboxIds.length > 0) {
      inboxesFallbackQuery = inboxesFallbackQuery.in('id', scopedInboxIds);
    } else {
      inboxesFallbackQuery = inboxesFallbackQuery.eq('id', '__none__');
    }
  }
  const inboxesResult = inboxesFullResult.error
    ? await inboxesFallbackQuery
    : inboxesFullResult;

  const leadCountQuery = (configure?: (query: any) => any) => {
    let query: any = supabase.from('leads').select('id', { count: 'exact', head: true });
    if (scopedOperatorId) query = query.eq('operator_id', scopedOperatorId);
    return configure ? configure(query) : query;
  };
  const sevenDaysAgoIso = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const [
    leadTotalResult,
    leadUsedResult,
    leadFreeReadyResult,
    leadBlockedResult,
    repliedResult,
    repliedLast7dResult,
    unreviewedRepliesResult,
    interestedRepliesResult,
  ] = await Promise.all([
    leadCountQuery(),
    leadCountQuery((query) => query.eq('is_used', true)),
    leadCountQuery((query) => query
      .or('is_used.is.null,is_used.eq.false')
      .or('is_suppressed.is.null,is_suppressed.eq.false')
      .in('email_eligibility', ['eligible', 'risky'])),
    leadCountQuery((query) => query.or('email_eligibility.eq.blocked,permanently_failed.eq.true,is_suppressed.eq.true')),
    leadCountQuery((query) => query.eq('status', 'replied')),
    leadCountQuery((query) => query.eq('status', 'replied').gte('replied_at', sevenDaysAgoIso)),
    leadCountQuery((query) => query.eq('status', 'replied').or('interest_status.is.null,interest_status.eq.unreviewed')),
    leadCountQuery((query) => query.eq('status', 'replied').eq('interest_status', 'interested')),
  ]);

  if (campaignsResult.error) throw campaignsResult.error;
  if (inboxesResult.error) throw inboxesResult.error;
  if (campaignInboxesResult.error) throw campaignInboxesResult.error;
  const leadCountResults = [
    leadTotalResult,
    leadUsedResult,
    leadFreeReadyResult,
    leadBlockedResult,
    repliedResult,
    repliedLast7dResult,
    unreviewedRepliesResult,
    interestedRepliesResult,
  ];
  const leadCountError = leadCountResults.find((result) => result.error)?.error;
  if (leadCountError) throw leadCountError;

  const inboxes = ((inboxesResult.data ?? []) as InboxRow[]).map((row) => ({
    ...row,
    hard_paused: row.hard_paused ?? false,
    warmup_enabled: row.warmup_enabled ?? false,
    warmup_day: row.warmup_day ?? 1,
  }));
  const campaignInboxes = (campaignInboxesResult.data ?? []) as CampaignInboxRow[];

  const runningCampaignIds = new Set(
    campaigns
      .filter((c) => String(c.status ?? '').toLowerCase() === 'running')
      .map((c) => c.id)
  );

  const inUseInboxIds = new Set(
    campaignInboxes
      .filter((row) => runningCampaignIds.has(String(row.campaign_id)))
      .map((row) => String(row.inbox_id))
  );

  const activeInboxes = inboxes.filter((inbox) => (
    String(inbox.status ?? '').toLowerCase() === 'active' &&
    inbox.is_paused !== true &&
    inbox.hard_paused !== true
  ));

  const totalDailyCapacity = activeInboxes.reduce((sum, inbox) => {
    try {
      const { dailyLimit } = resolveInboxEffectiveLimits({
        daily_limit: toSafeNumber(inbox.daily_limit, 0),
        hourly_limit: toSafeNumber(inbox.hourly_limit, 0),
        warmup_enabled: inbox.warmup_enabled ?? false,
        warmup_day: toSafeNumber(inbox.warmup_day, 1),
      }, sendingLimits);
      return sum + Math.max(0, toSafeNumber(dailyLimit, 0));
    } catch (error) {
      console.warn('[STATS_OPERATIONS_SUMMARY_CAPACITY_FALLBACK]', {
        inboxId: inbox.id,
        message: getErrorMessage(error),
      });
      return sum + Math.max(0, toSafeNumber(inbox.daily_limit, 0));
    }
  }, 0);

  const inUseDailyCapacity = activeInboxes.reduce((sum, inbox) => {
    if (!inUseInboxIds.has(String(inbox.id))) return sum;
    try {
      const { dailyLimit } = resolveInboxEffectiveLimits({
        daily_limit: toSafeNumber(inbox.daily_limit, 0),
        hourly_limit: toSafeNumber(inbox.hourly_limit, 0),
        warmup_enabled: inbox.warmup_enabled ?? false,
        warmup_day: toSafeNumber(inbox.warmup_day, 1),
      }, sendingLimits);
      return sum + Math.max(0, toSafeNumber(dailyLimit, 0));
    } catch (error) {
      console.warn('[STATS_OPERATIONS_SUMMARY_CAPACITY_IN_USE_FALLBACK]', {
        inboxId: inbox.id,
        message: getErrorMessage(error),
      });
      return sum + Math.max(0, toSafeNumber(inbox.daily_limit, 0));
    }
  }, 0);

  const idleInboxes = activeInboxes.filter((inbox) => !inUseInboxIds.has(String(inbox.id)));
  const idleDailyCapacity = totalDailyCapacity - inUseDailyCapacity;

  const minHealth = toSafeNumber(sendingLimits.min_inbox_health_score, 60);
  const inboxesNeedingAttention = inboxes.filter((inbox) => (
    inbox.hard_paused === true ||
    inbox.is_paused === true ||
    toSafeNumber(inbox.health_score, 100) < minHealth
  )).length;

  const usedCount = Number(leadUsedResult.count ?? 0);
  const freeSendReady = Number(leadFreeReadyResult.count ?? 0);
  const blockedOrFailed = Number(leadBlockedResult.count ?? 0);

  return {
    campaigns: {
      total: campaigns.length,
      running: campaigns.filter((c) => String(c.status ?? '').toLowerCase() === 'running').length,
      paused: campaigns.filter((c) => String(c.status ?? '').toLowerCase() === 'paused').length,
      draft: campaigns.filter((c) => String(c.status ?? '').toLowerCase() === 'draft').length,
    },
    inboxes: {
      total: inboxes.length,
      active: activeInboxes.length,
      in_use: activeInboxes.filter((inbox) => inUseInboxIds.has(String(inbox.id))).length,
      idle: idleInboxes.length,
      paused: inboxes.filter((inbox) => inbox.is_paused === true).length,
      hard_paused: inboxes.filter((inbox) => inbox.hard_paused === true).length,
    },
    capacity: {
      total_daily_capacity: totalDailyCapacity,
      in_use_daily_capacity: inUseDailyCapacity,
      idle_daily_capacity: Math.max(0, idleDailyCapacity),
    },
    leads: {
      total: Number(leadTotalResult.count ?? 0),
      free_send_ready: freeSendReady,
      used: usedCount,
      blocked_or_failed: blockedOrFailed,
    },
    replies: {
      total_replied: Number(repliedResult.count ?? 0),
      replied_last_7d: Number(repliedLast7dResult.count ?? 0),
      unreviewed_replies: Number(unreviewedRepliesResult.count ?? 0),
      interested_replies: Number(interestedRepliesResult.count ?? 0),
    },
    health: {
      inboxes_needing_attention: inboxesNeedingAttention,
    },
  };
}
