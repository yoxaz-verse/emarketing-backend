export type SendDecision =
  | 'SEND'
  | 'DELAY'
  | 'PAUSE'
  | 'BLOCK'
import { getSendingLimitsConfig } from '../sendingLimitsConfig.service';

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

  if (lead.email_eligibility !== 'eligible') return 'BLOCK'

  if (inbox.health_score < config.min_inbox_health_score) return 'PAUSE'
  if (domain.health_score < config.min_domain_health_score) return 'PAUSE'

  if (campaign.daily_sent >= campaign.daily_limit) {
    return 'DELAY'
  }

  return 'SEND'
}
