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
  paused_until: string | null;
  rotation_index: number;
};

export type CampaignAllocatorResult = {
  eligible_count: number;
  blocked_by_reason: Record<string, number>;
  selected: AllocationCandidate | null;
  reason: string;
  candidates: AllocationCandidate[];
  schedule_allowed: boolean;
  schedule_reason: string | null;
  rotation_next_inbox_id: string | null;
  rotation_used_inbox_id: string | null;
  rotation_fallback_used: boolean;
  rotation_block_reason: string | null;
};

export type RotationSelectionInput<T extends { inbox_id: string }> = {
  candidates: T[];
  inboxIds: string[];
  minuteBucket: number;
};

export type RotationSelectionResult<T extends { inbox_id: string }> = {
  targetInboxId: string | null;
  selected: T | null;
  reason: 'eligible_sender_found' | 'rotation_target_inbox_ineligible';
  rotation_block_reason: string | null;
  rotation_fallback_used: boolean;
};

export function selectStrictRotationCandidate<T extends { inbox_id: string }>(
  input: RotationSelectionInput<T>
): RotationSelectionResult<T> {
  const ringSize = input.inboxIds.length;
  if (ringSize <= 0) {
    return {
      targetInboxId: null,
      selected: null,
      reason: 'rotation_target_inbox_ineligible',
      rotation_block_reason: 'no_campaign_inboxes',
      rotation_fallback_used: false,
    };
  }

  const targetRotationIndex = ((input.minuteBucket % ringSize) + ringSize) % ringSize;
  const targetInboxId = input.inboxIds[targetRotationIndex] ?? null;
  const selected = targetInboxId
    ? (input.candidates.find((candidate) => candidate.inbox_id === targetInboxId) ?? null)
    : null;

  if (!selected) {
    const candidateByInboxId = new Map(
      input.candidates.map((candidate) => [candidate.inbox_id, candidate] as const)
    );
    for (let offset = 1; offset < ringSize; offset += 1) {
      const idx = (targetRotationIndex + offset) % ringSize;
      const fallbackInboxId = input.inboxIds[idx] ?? null;
      if (!fallbackInboxId) continue;
      const fallback = candidateByInboxId.get(fallbackInboxId) ?? null;
      if (!fallback) continue;
      return {
        targetInboxId,
        selected: fallback,
        reason: 'eligible_sender_found',
        rotation_block_reason: 'rotation_target_inbox_ineligible',
        rotation_fallback_used: true,
      };
    }

    return {
      targetInboxId,
      selected: null,
      reason: 'rotation_target_inbox_ineligible',
      rotation_block_reason: 'rotation_target_inbox_ineligible',
      rotation_fallback_used: false,
    };
  }

  return {
    targetInboxId,
    selected,
    reason: 'eligible_sender_found',
    rotation_block_reason: null,
    rotation_fallback_used: false,
  };
}

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

function minuteBucketUtc(now: Date): number {
  return Math.floor(now.getTime() / 60000);
}

export function isInboxTemporarilyPaused(pausedUntilRaw: unknown, now: Date = new Date()): boolean {
  if (!pausedUntilRaw) return false;
  const dt = new Date(String(pausedUntilRaw));
  if (Number.isNaN(dt.getTime())) return false;
  return dt.getTime() > now.getTime();
}

export async function allocateCampaignSender(input: {
  campaignId: string;
  leadEligibility?: string | null;
  recipientEmail?: string | null;
  firstTouch?: boolean;
}): Promise<CampaignAllocatorResult> {
  const campaignId = String(input.campaignId ?? '').trim();
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
      rotation_next_inbox_id: null,
      rotation_used_inbox_id: null,
      rotation_fallback_used: false,
      rotation_block_reason: 'schedule_blocked',
    };
  }

  const { data: campaignInboxRows, error: campaignInboxError } = await supabase
    .from('campaign_inboxes')
    .select('inbox_id,created_at')
    .eq('campaign_id', campaignId);
  if (campaignInboxError) throw campaignInboxError;

  type CampaignInboxRow = { inbox_id: string; created_at: string };
  const orderedCampaignInboxIds: string[] = (campaignInboxRows ?? [])
    .map((r: any): CampaignInboxRow => ({
      inbox_id: String(r?.inbox_id ?? '').trim(),
      created_at: String(r?.created_at ?? ''),
    }))
    .filter((r: CampaignInboxRow) => r.inbox_id.length > 0)
    .sort((a: CampaignInboxRow, b: CampaignInboxRow) => {
      const aTs = a.created_at ? new Date(a.created_at).getTime() : 0;
      const bTs = b.created_at ? new Date(b.created_at).getTime() : 0;
      if (aTs !== bTs) return aTs - bTs;
      return a.inbox_id.localeCompare(b.inbox_id);
    })
    .map((r: CampaignInboxRow) => r.inbox_id);
  const inboxIds: string[] = Array.from(new Set(orderedCampaignInboxIds));
  if (inboxIds.length === 0) {
    return {
      eligible_count: 0,
      blocked_by_reason: { no_campaign_inboxes: 1 },
      selected: null,
      reason: 'no_campaign_inboxes',
      candidates: [],
      schedule_allowed: true,
      schedule_reason: null,
      rotation_next_inbox_id: null,
      rotation_used_inbox_id: null,
      rotation_fallback_used: false,
      rotation_block_reason: 'no_campaign_inboxes',
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
      paused_until,
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
    .select('inbox_id')
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
    if (isInboxTemporarilyPaused((inbox as any).paused_until, now)) {
      bump('inbox_temp_paused_until');
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
      paused_until: (inbox as any).paused_until ? String((inbox as any).paused_until) : null,
      rotation_index: inboxIds.indexOf(inboxId),
    });
  }

  const minuteBucket = minuteBucketUtc(now);
  const rotationSelection = selectStrictRotationCandidate({
    candidates,
    inboxIds,
    minuteBucket,
  });

  if (candidates.length === 0) {
    return {
      eligible_count: 0,
      blocked_by_reason: blockedByReason,
      selected: null,
      reason: Object.keys(blockedByReason)[0] ?? 'no_eligible_sender',
      candidates: [],
      schedule_allowed: true,
      schedule_reason: null,
      rotation_next_inbox_id: rotationSelection.targetInboxId,
      rotation_used_inbox_id: null,
      rotation_fallback_used: false,
      rotation_block_reason: Object.keys(blockedByReason)[0] ?? 'no_eligible_sender',
    };
  }

  if (!rotationSelection.selected) {
    return {
      eligible_count: candidates.length,
      blocked_by_reason: blockedByReason,
      selected: null,
      reason: rotationSelection.reason,
      candidates,
      schedule_allowed: true,
      schedule_reason: null,
      rotation_next_inbox_id: rotationSelection.targetInboxId,
      rotation_used_inbox_id: null,
      rotation_fallback_used: false,
      rotation_block_reason: rotationSelection.rotation_block_reason,
    };
  }

  return {
    eligible_count: candidates.length,
    blocked_by_reason: blockedByReason,
    selected: rotationSelection.selected,
    reason: rotationSelection.reason,
    candidates,
    schedule_allowed: true,
    schedule_reason: null,
    rotation_next_inbox_id: rotationSelection.targetInboxId,
    rotation_used_inbox_id: rotationSelection.selected.inbox_id,
    rotation_fallback_used: rotationSelection.rotation_fallback_used,
    rotation_block_reason: rotationSelection.rotation_block_reason,
  };
}
