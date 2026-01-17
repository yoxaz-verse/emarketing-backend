import { supabase } from '../supabase.js';

export async function handleLeadReply({
  from_email,
  message
}: {
  from_email: string;
  message?: string;
}) {
  // 1. Find lead
  const { data: lead } = await supabase
    .from('leads')
    .select('*')
    .eq('email', from_email)
    .single();

  if (!lead) return;

  // 2. Update lead
  await supabase
    .from('leads')
    .update({
      status: 'replied',
      replied_at: new Date().toISOString(),
      reply_message: message
    })
    .eq('id', lead.id);

    // Stop sequence on reply
await supabase
.from('lead_sequences')
.update({
  stopped: true,
  completed: true
})
.eq('lead_id', lead.id);


  // 3. Update inbox stats
  if (lead.assigned_inbox_id) {
    const { data: inbox } = await supabase
      .from('inboxes')
      .select('replies_count')
      .eq('id', lead.assigned_inbox_id)
      .single();

    await supabase
      .from('inboxes')
      .update({
        replies_count: (inbox?.replies_count ?? 0) + 1
      })
      .eq('id', lead.assigned_inbox_id);
  }

  // 4. Emit system event
  await supabase.from('system_events').insert({
    type: 'LEAD_REPLIED',
    entity: 'lead',
    entity_id: lead.id,
    message: 'Reply received from lead'
  });
}
