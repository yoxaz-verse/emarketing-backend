export function calculateDomainHealth({
    avgBounceRate,
  }: {
    avgBounceRate: number
  }) {
    let score = 100
    score -= avgBounceRate * 70
    return Math.max(0, Math.round(score))
  }
  