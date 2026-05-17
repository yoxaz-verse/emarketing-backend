import { SocialConnectorCapability, SocialPostInput } from './types';

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
