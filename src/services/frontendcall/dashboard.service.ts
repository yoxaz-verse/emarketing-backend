import { supabase } from "../../supabase";

type CampaignLead = {
  status: string | null
}

type CampaignDashboardRow = {
  id: string
  name: string
  status: string
  campaign_leads: CampaignLead[] | null
}

export async function getCampaignDashboard(operatorId: string) {
    const { data } = await supabase
      .from('campaigns')
      .select(`
        id,
        name,
        status,
        created_at,
        campaign_leads (
          status
        )
      `)
      .eq('operator_id', operatorId);
  
    return ((data ?? []) as CampaignDashboardRow[]).map((c) => {
      const leads = c.campaign_leads || [];
  
      return {
        id: c.id,
        name: c.name,
        status: c.status,
        total_leads: leads.length,
        completed: leads.filter((l) => l.status === 'completed').length,
        failed: leads.filter((l) => l.status === 'failed').length,
        queued: leads.filter((l) => l.status === 'queued').length,
      };
    });
  }
  
