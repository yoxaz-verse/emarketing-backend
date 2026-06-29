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

  let leadsFullQuery = supabase
    .from('leads')
    .select('id,is_used,email_eligibility,permanently_failed,is_suppressed,status,replied_at,interest_status');
  if (scopedOperatorId) {
    leadsFullQuery = leadsFullQuery.eq('operator_id', scopedOperatorId);
  }
  const leadsFullResult = await leadsFullQuery;

  let leadsFallbackQuery = supabase.from('leads').select('id,is_used,email_eligibility,permanently_failed,is_suppressed,status,replied_at');
  if (scopedOperatorId) {
    leadsFallbackQuery = leadsFallbackQuery.eq('operator_id', scopedOperatorId);
  }
  const leadsResult = leadsFullResult.error
    ? await leadsFallbackQuery
    : leadsFullResult;

  if (campaignsResult.error) throw campaignsResult.error;
  if (inboxesResult.error) throw inboxesResult.error;
  if (campaignInboxesResult.error) throw campaignInboxesResult.error;
  if (leadsResult.error) throw leadsResult.error;

  const inboxes = ((inboxesResult.data ?? []) as InboxRow[]).map((row) => ({
    ...row,
    hard_paused: row.hard_paused ?? false,
    warmup_enabled: row.warmup_enabled ?? false,
    warmup_day: row.warmup_day ?? 1,
  }));
  const campaignInboxes = (campaignInboxesResult.data ?? []) as CampaignInboxRow[];
  const leads = ((leadsResult.data ?? []) as LeadRow[]).map((row) => ({
    ...row,
    interest_status: row.interest_status ?? 'unreviewed',
  }));

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

  const replies = leads.filter((lead) => String(lead.status ?? '').toLowerCase() === 'replied');
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const repliedLast7d = replies.filter((lead) => {
    if (!lead.replied_at) return false;
    const dt = new Date(lead.replied_at);
    return !Number.isNaN(dt.getTime()) && dt >= sevenDaysAgo;
  }).length;

  const unreviewedReplies = replies.filter(
    (lead) => String(lead.interest_status ?? 'unreviewed').toLowerCase() === 'unreviewed'
  ).length;

  const interestedReplies = replies.filter(
    (lead) => String(lead.interest_status ?? '').toLowerCase() === 'interested'
  ).length;

  const minHealth = toSafeNumber(sendingLimits.min_inbox_health_score, 60);
  const inboxesNeedingAttention = inboxes.filter((inbox) => (
    inbox.hard_paused === true ||
    inbox.is_paused === true ||
    toSafeNumber(inbox.health_score, 100) < minHealth
  )).length;

  const usedCount = leads.filter((lead) => lead.is_used === true).length;
  const freeSendReady = leads.filter((lead) => {
    const eligibility = String(lead.email_eligibility ?? '').toLowerCase();
    return lead.is_used !== true && lead.is_suppressed !== true && (eligibility === 'eligible' || eligibility === 'risky');
  }).length;
  const blockedOrFailed = leads.filter((lead) => (
    String(lead.email_eligibility ?? '').toLowerCase() === 'blocked' ||
    lead.permanently_failed === true ||
    lead.is_suppressed === true
  )).length;

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
      total: leads.length,
      free_send_ready: freeSendReady,
      used: usedCount,
      blocked_or_failed: blockedOrFailed,
    },
    replies: {
      total_replied: replies.length,
      replied_last_7d: repliedLast7d,
      unreviewed_replies: unreviewedReplies,
      interested_replies: interestedReplies,
    },
    health: {
      inboxes_needing_attention: inboxesNeedingAttention,
    },
  };
}
