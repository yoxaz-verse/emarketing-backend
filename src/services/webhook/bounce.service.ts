import { supabase } from "../../supabase";

type BounceType = 'hard' | 'soft' | 'reply';

export async function handleBounce(
  email: string,
  type: BounceType,
  reason?: string
) {
  // Find active campaign lead for this email
  const { data: lead } = await supabase
    .from('leads')
    .select(`
      id,
      campaign_leads (
        id,
        campaign_id,
        status
      )
    `)
    .eq('email', email)
    .single();

  if (!lead || !lead.campaign_leads?.length) {
    return; // nothing to do
  }

  const campaignLead = lead.campaign_leads[0];

  // HARD BOUNCE → permanent stop
  if (type === 'hard') {
    await supabase
      .from('campaign_leads')
      .update({ status: 'failed' })
      .eq('id', campaignLead.id);
  }

  // SOFT BOUNCE → allow retry
  if (type === 'soft') {
    const retryAt = new Date();
    retryAt.setMinutes(retryAt.getMinutes() + 30);

    await supabase
      .from('campaign_leads')
      .update({
        status: 'queued',
        next_retry_at: retryAt.toISOString(),
      })
      .eq('id', campaignLead.id);
  }

  // REPLY → optional positive signal
  if (type === 'reply') {
    await supabase
      .from('campaign_leads')
      .update({ status: 'completed' })
      .eq('id', campaignLead.id);
  }

  // Always log
  await supabase.from('email_logs').insert({
    lead_id: lead.id,
    bounce_type: type,
    bounce_reason: reason,
  });
}
