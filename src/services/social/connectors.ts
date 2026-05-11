import { SocialConnectorCapability, SocialPostInput } from './types';

export type SocialExecutionResult = {
  status: 'manual_action_required' | 'published';
  external_post_id?: string;
  external_post_url?: string;
  manual_task?: Record<string, unknown>;
};

export function validateSocialPostInput(input: SocialPostInput): string[] {
  const errors: string[] = [];
  if (!input.content?.trim()) errors.push('content is required');
  if (!Array.isArray(input.media)) errors.push('media must be an array');
  if (!Array.isArray(input.hashtags)) errors.push('hashtags must be an array');
  if (input.scheduled_at && Number.isNaN(new Date(input.scheduled_at).getTime())) {
    errors.push('scheduled_at must be a valid ISO date-time');
  }
  return errors;
}

export function executeSocialPublish(connector: SocialConnectorCapability, input: SocialPostInput): SocialExecutionResult {
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
