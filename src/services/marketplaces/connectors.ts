import { ConnectorCapability, ListingInput } from './types';

export type ConnectorExecutionResult = {
  status: 'published' | 'partner_onboarding_required' | 'manual_action_required';
  external_listing_id?: string;
  external_listing_url?: string;
  manual_task?: Record<string, unknown>;
  partner_onboarding?: Record<string, unknown>;
};

export function validateListingInput(input: ListingInput): string[] {
  const errors: string[] = [];
  if (!input.title?.trim()) errors.push('title is required');
  if (!input.description?.trim()) errors.push('description is required');
  if (!input.category?.trim()) errors.push('category is required');
  if (!input.currency?.trim()) errors.push('currency is required');
  if (!Number.isFinite(input.price) || input.price <= 0) errors.push('price must be > 0');
  if (!Number.isFinite(input.moq) || input.moq <= 0) errors.push('moq must be > 0');
  if (!Number.isFinite(input.lead_time_days) || input.lead_time_days < 0) errors.push('lead_time_days must be >= 0');
  if (!input.seller_profile?.company_name?.trim()) errors.push('seller_profile.company_name is required');
  if (!Array.isArray(input.media)) errors.push('media must be an array');
  return errors;
}

export function executeConnectorPublish(connector: ConnectorCapability, input: ListingInput): ConnectorExecutionResult {
  const listingSlug = input.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

  if (connector.marketplace_status === 'no_api_manual') {
    return {
      status: 'manual_action_required',
      manual_task: {
        instruction: 'Manual-assisted publish required. Use deep link and prefilled payload.',
        deep_link_url: connector.deep_link_url,
        prefilled_payload: {
          title: input.title,
          category: input.category,
          moq: input.moq,
          price: input.price,
          currency: input.currency,
        },
      },
    };
  }

  if (connector.marketplace_status === 'partner_api' && !connector.credentials_active) {
    return {
      status: 'partner_onboarding_required',
      partner_onboarding: {
        message: 'Partner credentials are not active yet.',
        required_auth_type: connector.auth_type,
        connector_code: connector.code,
      },
    };
  }

  return {
    status: 'published',
    external_listing_id: `${connector.code}-${Date.now()}`,
    external_listing_url: `${connector.deep_link_url ?? `https://${connector.code}.com`}/listing/${listingSlug || 'item'}`,
  };
}
