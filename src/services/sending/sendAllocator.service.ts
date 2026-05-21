import { supabase } from '../../supabase';
import {
  getSendingLimitsConfig,
  isNowWithinSendingSchedule,
  resolveInboxEffectiveLimits,
} from '../sendingLimitsConfig.service';

type AllocationCandidate = {
  inbox_id: string;
  email_address: string;
  smtp_account_id: string | null;
  sending_domain_id: string | null;
  inbox_health_score: number;
  domain_health_score: number | null;
  domain_verified: boolean;
  inbox_daily_limit: number;
  inbox_hourly_limit: number;
  domain_daily_limit: number | null;
  domain_hourly_limit: number | null;
  sent_today_inbox: number;
  sent_hour_inbox: number;
  sent_today_domain: number;
  sent_hour_domain: number;
  rem_daily_inbox: number;
  rem_hour_inbox: number;
  rem_daily_domain: number;
  rem_hour_domain: number;
  domain_headroom: number;
  inbox_headroom: number;
  last_sent_at: string | null;
};

export type CampaignAllocatorResult = {
  eligible_count: number;
  blocked_by_reason: Record<string, number>;
  selected: AllocationCandidate | null;
  reason: string;
  candidates: AllocationCandidate[];
  schedule_allowed: boolean;
  schedule_reason: string | null;
};

function asNumber(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function getIsoDayStart(now: Date): string {
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}T00:00:00.000Z`;
}

export async function allocateCampaignSender(input: {
  campaignId: string;
  leadEligibility?: string | null;
}): Promise<CampaignAllocatorResult> {
  const campaignId = String(input.campaignId ?? '').trim();
  const leadEligibility = String(input.leadEligibility ?? '').toLowerCase();
  const blockedByReason: Record<string, number> = {};
  const bump = (reason: string) => {
    blockedByReason[reason] = (blockedByReason[reason] ?? 0) + 1;
  };

  const config = await getSendingLimitsConfig();
  const scheduleGate = isNowWithinSendingSchedule(config);
  if (!scheduleGate.allowed) {
    return {
      eligible_count: 0,
      blocked_by_reason: { schedule_blocked: 1 },
      selected: null,
      reason: 'schedule_blocked',
      candidates: [],
      schedule_allowed: false,
      schedule_reason: scheduleGate.reason ?? 'schedule_blocked',
    };
  }

  const { data: campaignInboxRows, error: campaignInboxError } = await supabase
    .from('campaign_inboxes')
    .select('inbox_id')
    .eq('campaign_id', campaignId);
  if (campaignInboxError) throw campaignInboxError;

  const inboxIds = Array.from(
    new Set((campaignInboxRows ?? []).map((r: any) => String(r?.inbox_id ?? '')).filter(Boolean))
  );
  if (inboxIds.length === 0) {
    return {
      eligible_count: 0,
      blocked_by_reason: { no_campaign_inboxes: 1 },
      selected: null,
      reason: 'no_campaign_inboxes',
      candidates: [],
      schedule_allowed: true,
      schedule_reason: null,
    };
  }

  const { data: inboxRows, error: inboxError } = await supabase
    .from('inboxes')
    .select(`
      id,
      email_address,
      smtp_account_id,
      sending_domain_id,
      daily_limit,
      hourly_limit,
      warmup_enabled,
      warmup_day,
      health_score,
      is_paused,
      hard_paused,
      status,
      last_sent_at
    `)
    .in('id', inboxIds);
  if (inboxError) throw inboxError;

  const domainIds = Array.from(
    new Set((inboxRows ?? []).map((r: any) => String(r?.sending_domain_id ?? '')).filter(Boolean))
  );
  const domainById = new Map<string, any>();
  if (domainIds.length > 0) {
    const { data: domainRows, error: domainError } = await supabase
      .from('sending_domains')
      .select('id, daily_limit, hourly_limit, health_score, spf_verified, dkim_verified, dmarc_verified')
      .in('id', domainIds);
    if (domainError) throw domainError;
    for (const row of domainRows ?? []) domainById.set(String((row as any).id), row);
  }

  const now = new Date();
  const hourAgoIso = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
  const dayStartIso = getIsoDayStart(now);

  const { data: sentTodayRows, error: sentTodayError } = await supabase
    .from('email_logs')
    .select('inbox_id, lead_id')
    .eq('status', 'sent')
    .in('inbox_id', inboxIds)
    .gte('sent_at', dayStartIso);
  if (sentTodayError) throw sentTodayError;

  const { data: sentHourRows, error: sentHourError } = await supabase
    .from('email_logs')
    .select('inbox_id')
    .eq('status', 'sent')
    .in('inbox_id', inboxIds)
    .gte('sent_at', hourAgoIso);
  if (sentHourError) throw sentHourError;

  const sentTodayByInbox = new Map<string, number>();
  for (const row of sentTodayRows ?? []) {
    const id = String((row as any)?.inbox_id ?? '');
    if (!id) continue;
    sentTodayByInbox.set(id, (sentTodayByInbox.get(id) ?? 0) + 1);
  }

  const riskySentTodayByInbox = new Map<string, number>();
  if (leadEligibility === 'risky') {
    const sentLeadIds = Array.from(
      new Set((sentTodayRows ?? []).map((row: any) => String(row?.lead_id ?? '')).filter(Boolean))
    );
    if (sentLeadIds.length > 0) {
      const { data: riskyLeadRows, error: riskyLeadError } = await supabase
        .from('leads')
        .select('id')
        .in('id', sentLeadIds)
        .eq('email_eligibility', 'risky');
      if (riskyLeadError) throw riskyLeadError;

      const riskyLeadIdSet = new Set(
        (riskyLeadRows ?? []).map((row: any) => String((row as any)?.id ?? '')).filter(Boolean)
      );
      for (const row of sentTodayRows ?? []) {
        const inboxId = String((row as any)?.inbox_id ?? '');
        const leadId = String((row as any)?.lead_id ?? '');
        if (!inboxId || !riskyLeadIdSet.has(leadId)) continue;
        riskySentTodayByInbox.set(inboxId, (riskySentTodayByInbox.get(inboxId) ?? 0) + 1);
      }
    }
  }

  const sentHourByInbox = new Map<string, number>();
  for (const row of sentHourRows ?? []) {
    const id = String((row as any)?.inbox_id ?? '');
    if (!id) continue;
    sentHourByInbox.set(id, (sentHourByInbox.get(id) ?? 0) + 1);
  }

  const sentTodayByDomain = new Map<string, number>();
  const sentHourByDomain = new Map<string, number>();
  for (const inbox of inboxRows ?? []) {
    const inboxId = String((inbox as any).id);
    const domainId = String((inbox as any).sending_domain_id ?? '');
    if (!domainId) continue;
    sentTodayByDomain.set(
      domainId,
      (sentTodayByDomain.get(domainId) ?? 0) + (sentTodayByInbox.get(inboxId) ?? 0)
    );
    sentHourByDomain.set(
      domainId,
      (sentHourByDomain.get(domainId) ?? 0) + (sentHourByInbox.get(inboxId) ?? 0)
    );
  }

  const candidates: AllocationCandidate[] = [];
  for (const inbox of inboxRows ?? []) {
    const inboxId = String((inbox as any).id ?? '');
    const domainId = String((inbox as any).sending_domain_id ?? '');
    const domain = domainById.get(domainId) ?? null;

    if (Boolean((inbox as any).hard_paused)) {
      bump('inbox_hard_paused');
      continue;
    }
    if (Boolean((inbox as any).is_paused) || String((inbox as any).status ?? '').toLowerCase() === 'paused') {
      bump('inbox_paused');
      continue;
    }
    if (!(inbox as any).smtp_account_id) {
      bump('missing_smtp');
      continue;
    }

    const inboxHealth = asNumber((inbox as any).health_score, 100);
    if (inboxHealth < config.min_inbox_health_score) {
      bump('inbox_gated');
      continue;
    }

    if (!domain) {
      bump('domain_missing');
      continue;
    }

    const domainHealth = asNumber((domain as any).health_score, 100);
    const domainVerified = Boolean((domain as any).spf_verified)
      && Boolean((domain as any).dkim_verified)
      && Boolean((domain as any).dmarc_verified);
    if (!domainVerified || domainHealth < config.min_domain_health_score) {
      bump('domain_gated');
      continue;
    }

    const { dailyLimit, hourlyLimit } = resolveInboxEffectiveLimits(inbox as any, config);
    const sentTodayInbox = sentTodayByInbox.get(inboxId) ?? 0;
    const sentHourInbox = sentHourByInbox.get(inboxId) ?? 0;
    const remDailyInbox = dailyLimit - sentTodayInbox;
    const remHourInbox = hourlyLimit - sentHourInbox;

    const domainDailyLimit = asNumber((domain as any).daily_limit, 0);
    const domainHourlyLimit = asNumber((domain as any).hourly_limit, 0);
    const sentTodayDomain = sentTodayByDomain.get(domainId) ?? 0;
    const sentHourDomain = sentHourByDomain.get(domainId) ?? 0;
    const remDailyDomain = domainDailyLimit - sentTodayDomain;
    const remHourDomain = domainHourlyLimit - sentHourDomain;

    if (remDailyInbox <= 0) {
      bump('capacity_daily_exhausted');
      continue;
    }
    if (remHourInbox <= 0) {
      bump('capacity_hourly_exhausted');
      continue;
    }
    if (remDailyDomain <= 0) {
      bump('domain_daily_exhausted');
      continue;
    }
    if (remHourDomain <= 0) {
      bump('domain_hourly_exhausted');
      continue;
    }

    if (leadEligibility === 'risky') {
      const riskyPercent = Math.max(0, Math.min(100, Number(config.risky_daily_percent_limit ?? 20)));
      const allowedRiskyPerDay = Math.max(0, Math.floor((dailyLimit * riskyPercent) / 100));
      const riskySentToday = riskySentTodayByInbox.get(inboxId) ?? 0;
      if (riskySentToday >= allowedRiskyPerDay) {
        bump('risky_daily_cap_reached');
        continue;
      }
    }

    candidates.push({
      inbox_id: inboxId,
      email_address: String((inbox as any).email_address ?? ''),
      smtp_account_id: (inbox as any).smtp_account_id ? String((inbox as any).smtp_account_id) : null,
      sending_domain_id: domainId || null,
      inbox_health_score: inboxHealth,
      domain_health_score: domainHealth,
      domain_verified: domainVerified,
      inbox_daily_limit: dailyLimit,
      inbox_hourly_limit: hourlyLimit,
      domain_daily_limit: domainDailyLimit,
      domain_hourly_limit: domainHourlyLimit,
      sent_today_inbox: sentTodayInbox,
      sent_hour_inbox: sentHourInbox,
      sent_today_domain: sentTodayDomain,
      sent_hour_domain: sentHourDomain,
      rem_daily_inbox: remDailyInbox,
      rem_hour_inbox: remHourInbox,
      rem_daily_domain: remDailyDomain,
      rem_hour_domain: remHourDomain,
      domain_headroom: Math.min(remDailyDomain, remHourDomain),
      inbox_headroom: Math.min(remDailyInbox, remHourInbox),
      last_sent_at: (inbox as any).last_sent_at ? String((inbox as any).last_sent_at) : null,
    });
  }

  if (candidates.length === 0) {
    return {
      eligible_count: 0,
      blocked_by_reason: blockedByReason,
      selected: null,
      reason: Object.keys(blockedByReason)[0] ?? 'no_eligible_sender',
      candidates: [],
      schedule_allowed: true,
      schedule_reason: null,
    };
  }

  candidates.sort((a, b) => {
    if (b.domain_headroom !== a.domain_headroom) return b.domain_headroom - a.domain_headroom;
    if (b.inbox_headroom !== a.inbox_headroom) return b.inbox_headroom - a.inbox_headroom;
    const aTs = a.last_sent_at ? new Date(a.last_sent_at).getTime() : 0;
    const bTs = b.last_sent_at ? new Date(b.last_sent_at).getTime() : 0;
    if (aTs !== bTs) return aTs - bTs;
    return a.inbox_id.localeCompare(b.inbox_id);
  });

  return {
    eligible_count: candidates.length,
    blocked_by_reason: blockedByReason,
    selected: candidates[0],
    reason: 'eligible_sender_found',
    candidates,
    schedule_allowed: true,
    schedule_reason: null,
  };
}
