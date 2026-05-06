import { supabase } from '../supabase';

export type WarmupStep = {
  day: number;
  daily_limit: number;
  hourly_limit: number;
};

export type SendingLimitsConfig = {
  min_inbox_health_score: number;
  min_domain_health_score: number;
  warmup_advance_min_health_score: number;
  warmup_advance_max_consecutive_failures: number;
  warmup_steps: WarmupStep[];
  updated_at?: string;
};

const DEFAULT_CONFIG: SendingLimitsConfig = {
  min_inbox_health_score: 60,
  min_domain_health_score: 60,
  warmup_advance_min_health_score: 70,
  warmup_advance_max_consecutive_failures: 2,
  warmup_steps: [
    { day: 1, daily_limit: 20, hourly_limit: 5 },
    { day: 2, daily_limit: 30, hourly_limit: 8 },
    { day: 3, daily_limit: 40, hourly_limit: 10 },
    { day: 4, daily_limit: 60, hourly_limit: 15 },
    { day: 5, daily_limit: 80, hourly_limit: 20 },
  ],
};

function sanitizeSteps(raw: unknown): WarmupStep[] {
  const input = Array.isArray(raw) ? raw : [];
  const valid = input
    .map((s: any) => ({
      day: Number(s?.day),
      daily_limit: Number(s?.daily_limit),
      hourly_limit: Number(s?.hourly_limit),
    }))
    .filter(
      (s) =>
        Number.isInteger(s.day) &&
        s.day > 0 &&
        Number.isInteger(s.daily_limit) &&
        s.daily_limit > 0 &&
        Number.isInteger(s.hourly_limit) &&
        s.hourly_limit > 0
    )
    .sort((a, b) => a.day - b.day);

  return valid;
}

function sanitizeConfig(raw: any): SendingLimitsConfig {
  return {
    min_inbox_health_score:
      Number.isFinite(Number(raw?.min_inbox_health_score))
        ? Number(raw.min_inbox_health_score)
        : DEFAULT_CONFIG.min_inbox_health_score,
    min_domain_health_score:
      Number.isFinite(Number(raw?.min_domain_health_score))
        ? Number(raw.min_domain_health_score)
        : DEFAULT_CONFIG.min_domain_health_score,
    warmup_advance_min_health_score:
      Number.isFinite(Number(raw?.warmup_advance_min_health_score))
        ? Number(raw.warmup_advance_min_health_score)
        : DEFAULT_CONFIG.warmup_advance_min_health_score,
    warmup_advance_max_consecutive_failures:
      Number.isFinite(Number(raw?.warmup_advance_max_consecutive_failures))
        ? Number(raw.warmup_advance_max_consecutive_failures)
        : DEFAULT_CONFIG.warmup_advance_max_consecutive_failures,
    warmup_steps: sanitizeSteps(raw?.warmup_steps),
    updated_at: raw?.updated_at,
  };
}

function validateConfig(payload: SendingLimitsConfig) {
  const numericKeys = [
    'min_inbox_health_score',
    'min_domain_health_score',
    'warmup_advance_min_health_score',
    'warmup_advance_max_consecutive_failures',
  ] as const;

  for (const key of numericKeys) {
    const value = Number(payload[key]);
    if (!Number.isFinite(value)) throw new Error(`${key} must be a number`);
    if (key.includes('health_score') && (value < 0 || value > 100)) {
      throw new Error(`${key} must be between 0 and 100`);
    }
    if (key === 'warmup_advance_max_consecutive_failures' && value < 0) {
      throw new Error(`${key} must be >= 0`);
    }
  }

  if (!Array.isArray(payload.warmup_steps) || payload.warmup_steps.length === 0) {
    throw new Error('warmup_steps must contain at least 1 row');
  }

  const seenDays = new Set<number>();
  for (const step of payload.warmup_steps) {
    if (!Number.isInteger(step.day) || step.day <= 0) {
      throw new Error('warmup_steps.day must be a positive integer');
    }
    if (seenDays.has(step.day)) {
      throw new Error(`Duplicate warmup day: ${step.day}`);
    }
    seenDays.add(step.day);

    if (!Number.isInteger(step.daily_limit) || step.daily_limit <= 0) {
      throw new Error(`warmup_steps daily_limit must be > 0 (day ${step.day})`);
    }
    if (!Number.isInteger(step.hourly_limit) || step.hourly_limit <= 0) {
      throw new Error(`warmup_steps hourly_limit must be > 0 (day ${step.day})`);
    }
  }
}

export async function getSendingLimitsConfig(): Promise<SendingLimitsConfig> {
  const { data, error } = await supabase
    .from('sending_limits_config')
    .select('*')
    .eq('id', true)
    .maybeSingle();

  if (error && !String(error.message ?? '').includes('Could not find the table')) {
    throw error;
  }

  if (!data) {
    return DEFAULT_CONFIG;
  }

  const normalized = sanitizeConfig(data);
  if (normalized.warmup_steps.length === 0) {
    normalized.warmup_steps = DEFAULT_CONFIG.warmup_steps;
  }
  return normalized;
}

export async function updateSendingLimitsConfig(
  payload: SendingLimitsConfig
): Promise<SendingLimitsConfig> {
  const normalized: SendingLimitsConfig = {
    min_inbox_health_score: Number(payload.min_inbox_health_score),
    min_domain_health_score: Number(payload.min_domain_health_score),
    warmup_advance_min_health_score: Number(payload.warmup_advance_min_health_score),
    warmup_advance_max_consecutive_failures: Number(payload.warmup_advance_max_consecutive_failures),
    warmup_steps: sanitizeSteps(payload.warmup_steps),
  };

  validateConfig(normalized);

  const { error } = await supabase
    .from('sending_limits_config')
    .upsert(
      {
        id: true,
        ...normalized,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'id' }
    );

  if (error) throw error;

  return getSendingLimitsConfig();
}

export function resolveInboxEffectiveLimits(
  inbox: {
    daily_limit: number;
    hourly_limit: number;
    warmup_enabled?: boolean | null;
    warmup_day?: number | null;
  },
  config: SendingLimitsConfig
) {
  let dailyLimit = inbox.daily_limit;
  let hourlyLimit = inbox.hourly_limit;

  if (inbox.warmup_enabled) {
    const targetDay = Number(inbox.warmup_day ?? 1);
    const step = config.warmup_steps.find((s) => s.day === targetDay);
    if (step) {
      dailyLimit = step.daily_limit;
      hourlyLimit = step.hourly_limit;
    }
  }

  return { dailyLimit, hourlyLimit };
}
