export const CAMPAIGN_UNSUBSCRIBE_REASON = 'user_unsubscribed_campaign';

export function isLeadSuppressed(input: {
  is_suppressed?: unknown;
  suppression_reason?: unknown;
}): boolean {
  return input.is_suppressed === true || String(input.suppression_reason ?? '').trim().length > 0;
}

