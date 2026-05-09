import { classifyBounce } from './bounceClassifier'
import type { SupabaseClient } from '@supabase/supabase-js'

type BouncePayload = {
  email: string
  body: string
  supabase: SupabaseClient
}

export async function handleBounce({
  email,
  body,
  supabase,
}: BouncePayload) {
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
