import { supabase } from '../supabase.js';

export async function getCampaignStats(operatorId: string) {
  const { count } = await supabase
    .from('lead_sequences')
    .select('*', { count: 'exact', head: true })
    .eq('operator_id', operatorId);

  const { data: running } = await supabase
    .from('lead_sequences')
    .select('id')
    .eq('operator_id', operatorId)
    .eq('campaign_status', 'running')
    .limit(1)
    .single();

  return {
    total_leads: count ?? 0,
    running: !!running
  };
}
