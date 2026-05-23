export function normalizeCampaignBatchSize(requestedBatchSize: number): {
  requested_batch_size: number;
  effective_batch_size: 1;
} {
  const requested = Number.isFinite(Number(requestedBatchSize))
    ? Math.max(1, Math.floor(Number(requestedBatchSize)))
    : 1;
  return {
    requested_batch_size: requested,
    effective_batch_size: 1,
  };
}

export function isCampaignMinuteBlocked(sentCountInWindow: number): boolean {
  return Number(sentCountInWindow) >= 1;
}
