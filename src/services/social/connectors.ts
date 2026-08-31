import { SocialConnectorCapability, SocialPlatformCode, SocialPostInput } from './types';

type LinkedInResult = {
  external_post_id: string;
  external_post_url: string;
};

export type SocialExecutionResult = {
  status: 'manual_action_required' | 'published';
  external_post_id?: string;
  external_post_url?: string;
  manual_task?: Record<string, unknown>;
  provider_error_code?: string;
  provider_error_message?: string;
};

const DEFAULT_SOCIAL_TIMEZONE = 'Asia/Kolkata';
const PLATFORM_LIMITS: Record<SocialPlatformCode, number> = {
  linkedin: 3000,
  meta: 2200,
  reddit: 40000,
  telegram: 4096,
  whatsapp: 1024,
};

function resolveValidTimeZone(timezone?: string): string {
  const candidate = String(timezone || '').trim();
  if (!candidate) return DEFAULT_SOCIAL_TIMEZONE;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: candidate }).format(new Date());
    return candidate;
  } catch {
    return DEFAULT_SOCIAL_TIMEZONE;
  }
}

function asDateInTimezone(date: Date, timeZone: string): Date {
  // Convert the same instant into wall-clock fields for the requested timezone.
  return new Date(date.toLocaleString('en-US', { timeZone }));
}

export function validateSocialPostInput(input: SocialPostInput): string[] {
  const errors: string[] = [];
  if (!input.content?.trim()) errors.push('content is required');
  if (!Array.isArray(input.media)) errors.push('media must be an array');
  if (!Array.isArray(input.hashtags)) errors.push('hashtags must be an array');
  if (input.scheduled_at) {
    const scheduledAt = new Date(input.scheduled_at);
    if (Number.isNaN(scheduledAt.getTime())) {
      errors.push('scheduled_at must be a valid ISO date-time');
    } else {
      const timezone = resolveValidTimeZone(input.timezone);
      const scheduledInTz = asDateInTimezone(scheduledAt, timezone);
      const nowInTz = asDateInTimezone(new Date(), timezone);
      if (scheduledInTz.getTime() <= nowInTz.getTime()) {
        errors.push('scheduled_at must be in the future');
      }
    }
  }
  return errors;
}

function uniqueTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    const tag = String(raw || '').trim().replace(/^#+/, '');
    if (!tag) continue;
    const normalized = tag.toLowerCase();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(`#${tag.replace(/\s+/g, '')}`);
  }
  return out;
}

function compactContent(content: string, limit: number): string {
  const normalized = String(content || '').replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n').trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, Math.max(0, limit - 3)).trimEnd()}...`;
}

function appendTags(content: string, tags: string[], limit: number): string {
  const tagLine = uniqueTags(tags).slice(0, 6).join(' ');
  if (!tagLine) return compactContent(content, limit);
  const base = compactContent(content, Math.max(0, limit - tagLine.length - 2));
  return compactContent(`${base}\n\n${tagLine}`, limit);
}

function platformContent(platform: SocialPlatformCode, input: SocialPostInput): string {
  const base = String(input.content || '').trim();
  const cta = String(input.cta_url || '').trim();
  if (platform === 'linkedin') {
    const withCta = cta && !base.includes(cta) ? `${base}\n\nLearn more: ${cta}` : base;
    return appendTags(withCta, input.hashtags, PLATFORM_LIMITS.linkedin);
  }
  if (platform === 'meta') {
    const withCta = cta && !base.includes(cta) ? `${base}\n\n${cta}` : base;
    return appendTags(withCta, input.hashtags, PLATFORM_LIMITS.meta);
  }
  if (platform === 'telegram') {
    const withCta = cta && !base.includes(cta) ? `${base}\n\n${cta}` : base;
    return appendTags(withCta, input.hashtags, PLATFORM_LIMITS.telegram);
  }
  if (platform === 'whatsapp') {
    const withCta = cta && !base.includes(cta) ? `${base}\n\n${cta}` : base;
    return compactContent(withCta, PLATFORM_LIMITS.whatsapp);
  }
  return appendTags(base, input.hashtags, PLATFORM_LIMITS.reddit);
}

export function resolvePlatformPostInput(platform: SocialPlatformCode, input: SocialPostInput): SocialPostInput {
  const override = input.platform_overrides?.[platform] ?? {};
  return {
    ...input,
    content: String(override.content ?? input.content ?? ''),
    media: Array.isArray(override.media) ? override.media : input.media,
    cta_url: override.cta_url ?? input.cta_url,
    hashtags: Array.isArray(override.hashtags) ? override.hashtags : input.hashtags,
  };
}

export function optimizeSocialPostInput(input: SocialPostInput, targets: SocialPlatformCode[]) {
  const validation_errors = validateSocialPostInput(input);
  const media = Array.isArray(input.media) ? input.media.map(String).filter(Boolean) : [];
  const hashtags = uniqueTags(input.hashtags ?? []);
  const platform_overrides: NonNullable<SocialPostInput['platform_overrides']> = {};
  const warnings: Record<string, string[]> = {};

  for (const platform of targets) {
    const platformWarnings: string[] = [];
    if (platform === 'meta' && media.length === 0) {
      platformWarnings.push('Instagram publishing requires at least one publicly reachable image or video URL; Facebook Page text publishing can continue without media.');
    }
    if (platform === 'linkedin' && media.length > 0) {
      platformWarnings.push('LinkedIn v1 publisher currently posts text/link content; media URLs are retained for future media publishing but not uploaded.');
    }
    if (media.some((url) => !/^https:\/\//i.test(url))) {
      platformWarnings.push('Media URLs should be HTTPS and publicly accessible for platform API ingestion.');
    }
    warnings[platform] = platformWarnings;
    platform_overrides[platform] = {
      content: platformContent(platform, { ...input, hashtags }),
      media,
      cta_url: input.cta_url,
      hashtags,
    };
  }

  return {
    post_input: {
      ...input,
      hashtags,
      media,
      platform_overrides,
    },
    platform_overrides,
    validation_errors,
    warnings,
  };
}

export function manualFallback(connector: SocialConnectorCapability, input: SocialPostInput): SocialExecutionResult {
  const normalizedContent = input.content.slice(0, 120).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

  return {
    status: 'manual_action_required',
    manual_task: {
      instruction: 'Manual-assisted publish required. Open platform link and post using prefilled payload.',
      deep_link_url: connector.deep_link_url,
      prefilled_payload: {
        content: input.content,
        media: input.media,
        cta_url: input.cta_url ?? null,
        hashtags: input.hashtags,
        scheduled_at: input.scheduled_at ?? null,
      },
      preview_slug: normalizedContent || 'post',
    },
  };
}

export function normalizeProviderError(err: unknown): { code: string; message: string; retryable: boolean } {
  const raw = err instanceof Error ? err.message : String(err);
  const status = Number((err as any)?.httpStatus ?? 0);

  if (status === 429 || status >= 500) {
    return {
      code: 'PROVIDER_RETRYABLE',
      message: raw,
      retryable: true,
    };
  }

  if (status === 401 || status === 403) {
    return {
      code: 'PROVIDER_AUTH_OR_SCOPE',
      message: raw,
      retryable: false,
    };
  }

  if (status >= 400 && status < 500) {
    return {
      code: 'PROVIDER_INVALID_PAYLOAD',
      message: raw,
      retryable: false,
    };
  }

  return {
    code: 'PROVIDER_UNKNOWN',
    message: raw,
    retryable: true,
  };
}

export function publishedResult(linkedIn: LinkedInResult): SocialExecutionResult {
  return {
    status: 'published',
    external_post_id: linkedIn.external_post_id,
    external_post_url: linkedIn.external_post_url,
  };
}
