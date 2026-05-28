export type SendDecision =
  | 'SEND'
  | 'DELAY'
  | 'PAUSE'
  | 'BLOCK'
import { getSendingLimitsConfig } from '../sendingLimitsConfig.service';

export function canPassPreSendEligibility(value: unknown): boolean {
  const eligibility = String(value ?? '').toLowerCase();
  return eligibility === 'eligible' || eligibility === 'risky';
}

export async function canSendEmail({
  lead,
  inbox,
  domain,
  campaign,
}: {
  lead: any
  inbox: any
  domain: any
  campaign: any
}): Promise<SendDecision> {
  const config = await getSendingLimitsConfig();

  if (!canPassPreSendEligibility(lead.email_eligibility)) return 'BLOCK'

  if (inbox.health_score < config.min_inbox_health_score) return 'PAUSE'
  if (domain.health_score < config.min_domain_health_score) return 'PAUSE'

  if (campaign.daily_sent >= campaign.daily_limit) {
    return 'DELAY'
  }

  return 'SEND'
}
