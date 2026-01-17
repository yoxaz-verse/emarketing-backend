import { supabase } from '../supabase.js';

export async function handleReply(params: {
  leadId: string;
  inboxId: string;
  message: string;
}) {
  const { leadId, inboxId, message } = params;

  // 1️⃣ Mark lead as replied
  await supabase
    .from('leads')
    .update({
      status: 'replied',
      replied_at: new Date().toISOString(),
      reply_message: message
    })
    .eq('id', leadId);

  // 2️⃣ HARD STOP ALL SEQUENCES FOR THIS LEAD
  await supabase
  .from('campaign_leads')
  .update({ status: 'completed' })
  .eq('lead_id', leadId);


  // 3️⃣ Log system event (optional but recommended)
  await supabase.from('system_events').insert({
    type: 'LEAD_REPLIED',
    entity: 'lead',
    entity_id: leadId,
    message: 'Sequence stopped due to reply'
  });
}
