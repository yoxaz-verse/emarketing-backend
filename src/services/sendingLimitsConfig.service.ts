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
  risky_daily_percent_limit: number;
  schedule_enabled: boolean;
  schedule_timezone: string;
  allowed_weekdays: number[];
  send_window_start: string;
  send_window_end: string;
  warmup_steps: WarmupStep[];
  updated_at?: string;
};

const DEFAULT_CONFIG: SendingLimitsConfig = {
  min_inbox_health_score: 60,
  min_domain_health_score: 60,
  warmup_advance_min_health_score: 70,
  warmup_advance_max_consecutive_failures: 2,
  risky_daily_percent_limit: 20,
  schedule_enabled: true,
  schedule_timezone: 'Asia/Kolkata',
  allowed_weekdays: [0, 1, 2, 3, 4, 5, 6],
  send_window_start: '00:00',
  send_window_end: '23:59',
  warmup_steps: [
    { day: 1, daily_limit: 20, hourly_limit: 5 },
    { day: 2, daily_limit: 30, hourly_limit: 8 },
    { day: 3, daily_limit: 40, hourly_limit: 10 },
    { day: 4, daily_limit: 60, hourly_limit: 15 },
    { day: 5, daily_limit: 80, hourly_limit: 20 },
  ],
};

const REQUIRED_SCHEDULE_KEYS: Array<keyof SendingLimitsConfig> = [
  'schedule_enabled',
  'schedule_timezone',
  'allowed_weekdays',
  'send_window_start',
  'send_window_end',
];

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

function sanitizeWeekdays(raw: unknown): number[] {
  const input = Array.isArray(raw) ? raw : [];
  const normalized = input
    .map((day) => Number(day))
    .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6);
  return Array.from(new Set(normalized)).sort((a, b) => a - b);
}

function isValidTimeFormat(raw: string): boolean {
  return /^([01]\d|2[0-3]):([0-5]\d)$/.test(raw);
}

function timeToMinutes(raw: string): number {
  const [hours, minutes] = raw.split(':').map(Number);
  return hours * 60 + minutes;
}

function isValidTimeZone(timeZone: string): boolean {
  try {
    Intl.DateTimeFormat('en-US', { timeZone }).format(new Date());
    return true;
  } catch {
    return false;
  }
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
    risky_daily_percent_limit:
      Number.isFinite(Number(raw?.risky_daily_percent_limit))
        ? Number(raw.risky_daily_percent_limit)
        : DEFAULT_CONFIG.risky_daily_percent_limit,
    schedule_enabled:
      typeof raw?.schedule_enabled === 'boolean'
        ? raw.schedule_enabled
        : DEFAULT_CONFIG.schedule_enabled,
    schedule_timezone:
      typeof raw?.schedule_timezone === 'string' && raw.schedule_timezone.trim()
        ? raw.schedule_timezone.trim()
        : DEFAULT_CONFIG.schedule_timezone,
    allowed_weekdays:
      sanitizeWeekdays(raw?.allowed_weekdays).length > 0
        ? sanitizeWeekdays(raw?.allowed_weekdays)
        : DEFAULT_CONFIG.allowed_weekdays,
    send_window_start:
      typeof raw?.send_window_start === 'string' && isValidTimeFormat(raw.send_window_start)
        ? raw.send_window_start
        : DEFAULT_CONFIG.send_window_start,
    send_window_end:
      typeof raw?.send_window_end === 'string' && isValidTimeFormat(raw.send_window_end)
        ? raw.send_window_end
        : DEFAULT_CONFIG.send_window_end,
    warmup_steps: sanitizeSteps(raw?.warmup_steps),
    updated_at: raw?.updated_at,
  };
}

function hasOwn(obj: unknown, key: string): boolean {
  return typeof obj === 'object' && obj !== null && Object.prototype.hasOwnProperty.call(obj, key);
}

function assertScheduleColumnsPresentInRow(raw: any) {
  for (const key of REQUIRED_SCHEDULE_KEYS) {
    if (!hasOwn(raw, key)) {
      throw new Error(
        `Sending limits schema mismatch: missing column "${String(
          key
        )}" in sending_limits_config. Apply migration 20260511_add_send_schedule_to_sending_limits_config.sql and restart backend.`
      );
    }
  }
}

function validateConfig(payload: SendingLimitsConfig) {
  const numericKeys = [
    'min_inbox_health_score',
    'min_domain_health_score',
    'warmup_advance_min_health_score',
    'warmup_advance_max_consecutive_failures',
    'risky_daily_percent_limit',
  ] as const;

  for (const key of numericKeys) {
    const value = Number(payload[key]);
    if (!Number.isFinite(value)) throw new Error(`${key} must be a number`);
    if (key.includes('health_score') && (value < 0 || value > 100)) {
      throw new Error(`${key} must be between 0 and 100`);
    }
    if (key === 'risky_daily_percent_limit' && (value < 0 || value > 100)) {
      throw new Error(`${key} must be between 0 and 100`);
    }
    if (key === 'warmup_advance_max_consecutive_failures' && value < 0) {
      throw new Error(`${key} must be >= 0`);
    }
  }

  if (!isValidTimeZone(payload.schedule_timezone)) {
    throw new Error('schedule_timezone must be a valid IANA timezone');
  }

  if (!Array.isArray(payload.allowed_weekdays) || payload.allowed_weekdays.length === 0) {
    throw new Error('allowed_weekdays must include at least one weekday');
  }

  const normalizedWeekdays = sanitizeWeekdays(payload.allowed_weekdays);
  if (normalizedWeekdays.length !== payload.allowed_weekdays.length) {
    throw new Error('allowed_weekdays must be unique integers between 0 and 6');
  }

  if (!isValidTimeFormat(payload.send_window_start)) {
    throw new Error('send_window_start must be in HH:mm format');
  }
  if (!isValidTimeFormat(payload.send_window_end)) {
    throw new Error('send_window_end must be in HH:mm format');
  }
  if (timeToMinutes(payload.send_window_end) < timeToMinutes(payload.send_window_start)) {
    throw new Error('send_window_end must be greater than or equal to send_window_start');
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

  assertScheduleColumnsPresentInRow(data);

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
    risky_daily_percent_limit: Number(payload.risky_daily_percent_limit),
    schedule_enabled: Boolean(payload.schedule_enabled),
    schedule_timezone: String(payload.schedule_timezone ?? '').trim(),
    allowed_weekdays: sanitizeWeekdays(payload.allowed_weekdays),
    send_window_start: String(payload.send_window_start ?? '').trim(),
    send_window_end: String(payload.send_window_end ?? '').trim(),
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

  const persisted = await getSendingLimitsConfig();

  const normalizedWeekdays = sanitizeWeekdays(normalized.allowed_weekdays);
  const persistedWeekdays = sanitizeWeekdays(persisted.allowed_weekdays);
  const weekdaysMatch =
    normalizedWeekdays.length === persistedWeekdays.length &&
    normalizedWeekdays.every((day, idx) => day === persistedWeekdays[idx]);

  const scheduleMatches =
    persisted.schedule_enabled === normalized.schedule_enabled &&
    persisted.schedule_timezone === normalized.schedule_timezone &&
    persisted.send_window_start === normalized.send_window_start &&
    persisted.send_window_end === normalized.send_window_end &&
    weekdaysMatch;

  if (!scheduleMatches) {
    throw new Error(
      'Backend schema/runtime mismatch: schedule fields were not persisted. Ensure migration 20260511_add_send_schedule_to_sending_limits_config.sql is applied and backend is restarted.'
    );
  }

  return persisted;
}

export function isNowWithinSendingSchedule(
  config: SendingLimitsConfig,
  now: Date = new Date()
): { allowed: boolean; reason?: string } {
  if (!config.schedule_enabled) {
    return { allowed: true };
  }

  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: config.schedule_timezone,
    hour12: false,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
  const parts = formatter.formatToParts(now);
  const weekday = parts.find((part) => part.type === 'weekday')?.value ?? '';
  const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? '0');
  const minute = Number(parts.find((part) => part.type === 'minute')?.value ?? '0');

  const weekdayMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  const weekdayNumber = weekdayMap[weekday];
  if (!Number.isInteger(weekdayNumber)) {
    return { allowed: false, reason: 'schedule_weekday_parse_failed' };
  }
  if (!config.allowed_weekdays.includes(weekdayNumber)) {
    return { allowed: false, reason: 'schedule_day_not_allowed' };
  }

  const currentMinutes = hour * 60 + minute;
  const startMinutes = timeToMinutes(config.send_window_start);
  const endMinutes = timeToMinutes(config.send_window_end);
  if (currentMinutes < startMinutes || currentMinutes > endMinutes) {
    return { allowed: false, reason: 'schedule_time_not_allowed' };
  }

  return { allowed: true };
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
