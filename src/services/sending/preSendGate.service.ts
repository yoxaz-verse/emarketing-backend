export type SendDecision =
  | 'SEND'
  | 'DELAY'
  | 'PAUSE'
  | 'BLOCK'

export function canSendEmail({
  lead,
  inbox,
  domain,
  campaign,
}: {
  lead: any
  inbox: any
  domain: any
  campaign: any
}): SendDecision {

  if (lead.email_eligibility !== 'eligible') return 'BLOCK'

  if (inbox.health_score < 60) return 'PAUSE'
  if (domain.health_score < 60) return 'PAUSE'

  if (campaign.daily_sent >= campaign.daily_limit) {
    return 'DELAY'
  }

  return 'SEND'
}
