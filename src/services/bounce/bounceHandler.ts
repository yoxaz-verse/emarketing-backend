import { classifyBounce } from './bounceClassifier'

export async function handleBounce({
  email,
  body,
  supabase,
}) {
  const type = classifyBounce(body)

  if (type === 'hard') {
    await supabase
      .from('leads')
      .update({
        email_eligibility: 'blocked',
        email_eligibility_reason: 'hard_bounce',
      })
      .eq('email', email)
  }
}
