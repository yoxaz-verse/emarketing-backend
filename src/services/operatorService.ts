import { supabase } from '../supabase.js';

export async function uploadLeads(
  operatorId: string|null,
  leads: any[]
) {
  const rows = leads.map((l) => ({
    email: l.email,
    first_name: l.first_name ?? null,
    company: l.company ?? null,
    status: 'pending',
    operator_id: operatorId
  }));

  await supabase.from('leads').insert(rows);
}

export async function assignSequence(
  operatorId: string | null,
  sequenceId: string
) {
  const { data: leads } = await supabase
    .from('leads')
    .select('id')
    .eq('operator_id', operatorId)
    .eq('status', 'pending');

  if (!leads || leads.length === 0) return;

  const rows = leads.map((l) => ({
    lead_id: l.id,
    sequence_id: sequenceId,
    operator_id: operatorId,
    campaign_status: 'draft'
  }));

  await supabase.from('lead_sequences').insert(rows);
}

export async function startCampaign(  operatorId: string | null
) {
  await supabase
    .from('lead_sequences')
    .update({ campaign_status: 'running' })
    .eq('operator_id', operatorId)
    .eq('campaign_status', 'draft');
}

export async function pauseCampaign(  operatorId: string | null
) {
  await supabase
    .from('lead_sequences')
    .update({ campaign_status: 'paused' })
    .eq('operator_id', operatorId)
    .eq('campaign_status', 'running');
}

export async function resumeCampaign(  operatorId: string | null
) {
  await supabase
    .from('lead_sequences')
    .update({ campaign_status: 'running' })
    .eq('operator_id', operatorId)
    .eq('campaign_status', 'paused');
}