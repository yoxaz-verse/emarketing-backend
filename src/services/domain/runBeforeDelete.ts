import { AllowedTable } from '../../config/allowedTables';
import { supabase } from '../../supabase';
import { handleUserBeforeDelete } from './userLifeCycle';
import { handleVoiceAgentsBeforeDelete } from './voiceAgentLifeCycle';

export async function runBeforeDelete(
  table: AllowedTable,
  id: string
) {
  const throwHttpError = (message: string, statusCode: number) => {
    const err = new Error(message) as Error & { statusCode?: number };
    err.statusCode = statusCode;
    throw err;
  };

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
      throwHttpError('Cannot delete a running campaign. Pause it first.', 409);
    }
    // Clean dependent rows for any non-running campaign state so delete does not fail
    // because of residual campaign_leads / campaign_inboxes references.
    if (campaign) {
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
    const { data: linkedCampaigns, error } = await supabase
      .from('campaigns')
      .select('id,status')
      .eq('sequence_id', id)
      .limit(1);

    if (error) throw error;
    if ((linkedCampaigns ?? []).length > 0) {
      const campaignStatus = String(linkedCampaigns?.[0]?.status ?? 'unknown');
      throwHttpError(
        `Sequence is linked to campaign(s) (first status: ${campaignStatus}) and cannot be deleted.`,
        409
      );
    }
  }

  // Add more tables later if needed
}
