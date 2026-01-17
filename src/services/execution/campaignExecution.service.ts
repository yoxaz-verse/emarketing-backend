import { supabase } from "../../supabase";

export async function getNextLeadsForCampaign(campaignId: string, limit = 10) {
  const { data, error } = await supabase
    .from('campaign_leads')
    .select(`
      id,
      lead_id,
      step_index,
      status,
      leads ( email )
    `)
    .eq('campaign_id', campaignId)
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(limit);

  if (error) throw error;
  return data;
}

export async function markLeadProcessing(id: string, executionId: string) {
  const { error } = await supabase
    .from('campaign_leads')
    .update({
      status: 'processing',
      execution_id: executionId,
      processing_at: new Date().toISOString(),
    })
    .eq('id', id)
    .eq('status', 'pending');

  if (error) throw error;
}

export async function markLeadSent(id: string) {
  const { error } = await supabase
    .from('campaign_leads')
    .update({
      status: 'sent',
      sent_at: new Date().toISOString(),
    })
    .eq('id', id)
    .eq('status', 'processing');

  if (error) throw error;
}

export async function markLeadFailed(id: string, reason: string) {
  const { error } = await supabase
    .from('campaign_leads')
    .update({
      status: 'failed',
      failure_reason: reason,
    })
    .eq('id', id)
    .eq('status', 'processing');

  if (error) throw error;
}

export async function completeStepIfDone(campaignId: string, stepIndex: number) {
  const { data } = await supabase
    .from('campaign_leads')
    .select('id')
    .eq('campaign_id', campaignId)
    .eq('step_index', stepIndex)
    .in('status', ['pending', 'processing']);

  if (data && data.length > 0) return false;

  await supabase
    .from('campaigns')
    .update({
      current_step_index: stepIndex + 1,
    })
    .eq('id', campaignId);

  return true;
}
