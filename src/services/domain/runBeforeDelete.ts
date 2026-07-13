import { AllowedTable } from '../../config/allowedTables';
import { supabase } from '../../supabase';
import { deleteCampaignDependents } from '../campaignDelete.service';
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
    await deleteCampaignDependents(id);
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
