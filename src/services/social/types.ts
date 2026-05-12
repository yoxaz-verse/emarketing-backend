export type SocialPlatformCode = 'meta' | 'linkedin' | 'reddit' | 'telegram' | 'whatsapp';

export type SocialConnectorStatus = 'manual_assisted' | 'api_enabled';
export type SocialAuthType = 'none' | 'oauth2';

export type SocialConnectionStatus = 'connected' | 'expired' | 'missing_scope' | 'disconnected';
export type PublishCapability = 'text_link' | 'image' | 'multi_media';

export type SocialConnectorCapability = {
  code: SocialPlatformCode;
  name: string;
  status: SocialConnectorStatus;
  auth_type: SocialAuthType;
  can_schedule: boolean;
  can_publish: boolean;
  credentials_active: boolean;
  deep_link_url: string | null;
  metadata: Record<string, unknown>;
};

export type SocialPostInput = {
  content: string;
  media: string[];
  cta_url?: string;
  hashtags: string[];
  timezone?: string;
  scheduled_at?: string | null;
};

export type CreateSocialPublishRequestInput = {
  idempotency_key?: string;
  targets: SocialPlatformCode[];
  post_input: SocialPostInput;
};

export type SocialJobPhase =
  | 'DRAFT_CREATE'
  | 'VALIDATE'
  | 'APPROVAL_PENDING'
  | 'AUTH_CHECK'
  | 'PAYLOAD_BUILD'
  | 'API_SUBMIT'
  | 'API_CONFIRMED'
  | 'PUBLISH';

export type SocialJobStatus =
  | 'draft_created'
  | 'validated'
  | 'approval_pending'
  | 'manual_action_required'
  | 'published'
  | 'failed';

export type SocialJobTimelineEvent = {
  at: string;
  phase: SocialJobPhase;
  status: SocialJobStatus;
  message: string;
  error_code?: string;
};
