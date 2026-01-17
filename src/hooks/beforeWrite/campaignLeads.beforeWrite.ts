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
    .select('id, email_eligibility')
    .in('id', leadIds)

  const invalid = leads?.filter(
    l => l.email_eligibility !== 'eligible'
  )

  if (invalid?.length) {
    throw new Error(
      'Blocked: Only eligible leads can be attached to campaigns'
    )
  }
}
