import { AllowedTable } from '../../config/allowedTables';
import { supabase } from '../../supabase';
import { handleUserBeforeDelete } from './userLifeCycle';
import { handleVoiceAgentsBeforeDelete } from './voiceAgentLifeCycle';

export async function runBeforeDelete(
  table: AllowedTable,
  id: string
) {
  if (table === 'voice_agents') {
    await handleVoiceAgentsBeforeDelete();
  }
  if (table === 'users') {
    await handleUserBeforeDelete(id);
  }
  if (table === 'campaigns') {
    const { data: campaign, error } = await supabase
      .from('campaigns')
      .select('id,status')
      .eq('id', id)
      .maybeSingle();

    if (error) throw error;
    if (campaign && String(campaign.status).toLowerCase() === 'running') {
      throw new Error('Cannot delete a running campaign. Pause it first.');
    }
    if (campaign && String(campaign.status).toLowerCase() === 'draft') {
      const { error: deleteCampaignLeadsError } = await supabase
        .from('campaign_leads')
        .delete()
        .eq('campaign_id', id);
      if (deleteCampaignLeadsError) throw deleteCampaignLeadsError;

      const { error: deleteCampaignInboxesError } = await supabase
        .from('campaign_inboxes')
        .delete()
        .eq('campaign_id', id);
      if (deleteCampaignInboxesError) throw deleteCampaignInboxesError;
    }
  }
  if (table === 'sequences') {
    const { data: runningCampaigns, error } = await supabase
      .from('campaigns')
      .select('id')
      .eq('sequence_id', id)
      .eq('status', 'running')
      .limit(1);

    if (error) throw error;
    if ((runningCampaigns ?? []).length > 0) {
      throw new Error('Sequence is used by running campaign(s) and cannot be deleted.');
    }
  }

  // Add more tables later if needed
}
