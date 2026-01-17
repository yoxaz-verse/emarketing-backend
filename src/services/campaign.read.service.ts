import { supabase } from '../supabase.js';

export async function getCampaignStats(
  operatorId: string | null
) {
  let campaignQuery = supabase
    .from('campaigns')
    .select('id, status')
    .order('created_at', { ascending: false })
    .limit(1);


  // Operator-scoped read
  if (operatorId) {
    campaignQuery = campaignQuery.eq('operator_id', operatorId);
  }

  const { data: campaign } = await campaignQuery.single();

  if (!campaign) {
    return { total_leads: 0, running: false };
  }

  const { count } = await supabase
    .from('campaign_leads')
    .select('*', { count: 'exact', head: true })
    .eq('campaign_id', campaign.id);

    console.log("campaign");
    console.log(campaign);
    
  return {
    total_leads: count ?? 0,
    running: campaign.status === 'running'
  };
}
