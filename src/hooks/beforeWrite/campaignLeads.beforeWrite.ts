import { SupabaseClient } from '@supabase/supabase-js'

type WriteMode = 'insert' | 'update' | 'delete'

export async function handleCampaignLeadsBeforeWrite(
  payload: any[],
  mode: WriteMode,
  supabase: SupabaseClient
) {
  if (mode !== 'insert') return

  const leadIds = payload.map(p => p.lead_id)

  const { data: leads } = await supabase
    .from('leads')
    .select('id, email_eligibility, is_used, is_blocked')
    .in('id', leadIds)

  const invalid = leads?.filter(
    l =>
      !['eligible', 'risky'].includes(String(l.email_eligibility ?? '').toLowerCase()) ||
      l.is_used === true ||
      l.is_blocked === true
  )

  if (invalid?.length) {
    throw new Error(
      'Blocked: Only eligible or risky leads can be attached to campaigns'
    )
  }
}
