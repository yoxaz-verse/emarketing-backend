export function calculateInboxHealth({
    hardBounceRate,
    softBounceRate,
  }: {
    hardBounceRate: number
    softBounceRate: number
  }) {
    let score = 100
    score -= hardBounceRate * 80
    score -= softBounceRate * 30
    return Math.max(0, Math.round(score))
  }
  