export type MarketplaceStatus = 'public_api' | 'partner_api' | 'no_api_manual';
export type ConnectorAuthType = 'none' | 'api_key' | 'oauth2' | 'partner';

export type ConnectorCapability = {
  code: string;
  name: string;
  marketplace_status: MarketplaceStatus;
  auth_type: ConnectorAuthType;
  can_create_draft: boolean;
  can_publish: boolean;
  can_update_price: boolean;
  can_update_inventory: boolean;
  supports_webhook: boolean;
  credentials_active: boolean;
  deep_link_url: string | null;
  metadata: Record<string, unknown>;
};

export type ListingInput = {
  title: string;
  description: string;
  category: string;
  specs: Record<string, string>;
  moq: number;
  price: number;
  currency: string;
  lead_time_days: number;
  media: string[];
  compliance_docs: string[];
  seller_profile: {
    company_name: string;
    contact_name?: string;
    country?: string;
    email?: string;
    phone?: string;
  };
};

export type CreatePublishRequestInput = {
  idempotency_key?: string;
  targets: string[];
  listing_input: ListingInput;
};

export type JobPhase = 'DRAFT_CREATE' | 'VALIDATE' | 'APPROVAL_PENDING' | 'PUBLISH';

export type JobStatus =
  | 'draft_created'
  | 'validated'
  | 'approval_pending'
  | 'partner_onboarding_required'
  | 'manual_action_required'
  | 'published'
  | 'failed';

export type JobTimelineEvent = {
  at: string;
  phase: JobPhase;
  status: JobStatus;
  message: string;
  error_code?: string;
};
