import { supabase } from "../../supabase";

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
  
    return (data ?? []).map(c => {
      const leads = c.campaign_leads || [];
  
      return {
        id: c.id,
        name: c.name,
        status: c.status,
        total_leads: leads.length,
        completed: leads.filter(l => l.status === 'completed').length,
        failed: leads.filter(l => l.status === 'failed').length,
        queued: leads.filter(l => l.status === 'queued').length,
      };
    });
  }
  