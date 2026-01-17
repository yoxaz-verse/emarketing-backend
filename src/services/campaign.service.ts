import { supabase } from '../supabase.js';

export async function getOrCreateDraftCampaign(operatorId: string) {
  const { data: existing } = await supabase
    .from('campaigns')
    .select('*')
    .eq('operator_id', operatorId)
    .eq('status', 'draft')
    .single();

  if (existing) return existing;

  const { data } = await supabase
    .from('campaigns')
    .insert({
      operator_id: operatorId,
      name: 'Default Campaign',
      status: 'draft'
    })
    .select()
    .single();

  return data;
}

export async function assignSequenceToCampaign(
  operatorId: string,
  sequenceId: string
) {
  const campaign = await getOrCreateDraftCampaign(operatorId);

  await supabase
    .from('campaigns')
    .update({ sequence_id: sequenceId })
    .eq('id', campaign.id);

  // attach leads
  const { data: leads } = await supabase
    .from('leads')
    .select('id')
    .eq('operator_id', operatorId);

  if (!leads?.length) return;

  const rows = leads.map(l => ({
    campaign_id: campaign.id,
    lead_id: l.id,
    status: 'queued'
  }));

  await supabase.from('campaign_leads').insert(rows);
}

export async function startCampaign(operatorId: string) {
  const campaign = await getOrCreateDraftCampaign(operatorId);

  if (!campaign.sequence_id) {
    throw new Error('Sequence not assigned');
  }

  await supabase
    .from('campaigns')
    .update({ status: 'running' })
    .eq('id', campaign.id);
}

export async function pauseCampaign(operatorId: string) {
  await supabase
    .from('campaigns')
    .update({ status: 'paused' })
    .eq('operator_id', operatorId)
    .eq('status', 'running');
}
