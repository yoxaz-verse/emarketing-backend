import { supabase } from '../supabase.js';

export async function logSendSuccess({
  lead_id,
  inbox_id,
  subject,
  body
}: any) {
  if (!lead_id || !inbox_id) {
    throw new Error('Missing lead_id or inbox_id');
  }

  await supabase.from('email_logs').insert({
    lead_id,
    inbox_id,
    subject,
    body,
    status: 'sent'
  });

  // Advance sequence step
await supabase
.from('lead_sequences')
.update({
  current_step: supabase.rpc('increment', { x: 1 }),
  last_sent_at: new Date().toISOString()
})
.eq('lead_id', lead_id);
// Check if sequence is completed
const { data: seq } = await supabase
  .from('lead_sequences')
  .select('sequence_id, current_step')
  .eq('lead_id', lead_id)
  .single();

if (seq) {
  const { count: totalSteps } = await supabase
    .from('sequence_steps')
    .select('*', { count: 'exact', head: true })
    .eq('sequence_id', seq.sequence_id);

  if (totalSteps && seq.current_step >= totalSteps) {
    await supabase
      .from('lead_sequences')
      .update({ completed: true })
      .eq('lead_id', lead_id);
  }
}


  await supabase
    .from('leads')
    .update({ status: 'sent' })
    .eq('id', lead_id);
await supabase
  .from('leads')
  .update({
    retry_count: 0,
    next_retry_at: null
  })
  .eq('id', lead_id);

  await supabase
    .from('inboxes')
    .update({
      consecutive_failures: 0,
      last_sent_at: new Date().toISOString()
    })
    .eq('id', inbox_id);

await supabase.rpc('increment_inbox_sent', {
        inbox_id_param: inbox_id
      });
      
}

export async function logSendFailure({
  lead_id,
  inbox_id,
  subject,
  body,
  error
}: any) {
  await supabase.from('email_logs').insert({
    lead_id,
    inbox_id,
    subject,
    body,
    status: 'failed'
  });

  // Update lead retry state
const { data: lead } = await supabase
.from('leads')
.select('retry_count')
.eq('id', lead_id)
.single();

const retryCount = (lead?.retry_count ?? 0) + 1;

if (retryCount >= 3) {
// Permanently fail lead
await supabase
  .from('leads')
  .update({
    permanently_failed: true,
    status: 'failed'
  })
  .eq('id', lead_id);
} else {
// Schedule retry
const nextRetry = new Date();
nextRetry.setHours(nextRetry.getHours() + 24);

await supabase
  .from('leads')
  .update({
    retry_count: retryCount,
    next_retry_at: nextRetry.toISOString()
  })
  .eq('id', lead_id);
}

await supabase.from('system_events').insert({
    type: 'LEAD_RETRY_SCHEDULED',
    entity: 'lead',
    entity_id: lead_id,
    message: retryCount >= 3
      ? 'Lead permanently failed after max retries'
      : 'Lead scheduled for retry'
  });
  
  const { data: inbox } = await supabase
    .from('inboxes')
    .select('consecutive_failures')
    .eq('id', inbox_id)
    .single();

  const failures = (inbox?.consecutive_failures ?? 0) + 1;

  const update: any = { consecutive_failures: failures };

  if (failures >= 3) {
    update.status = 'paused';
    update.paused_reason = 'Auto-paused after failures';
  
    // 👇 ADD THIS HERE
    await supabase.from('system_events').insert({
      type: 'INBOX_PAUSED',
      entity: 'inbox',
      entity_id: inbox_id,
      message: 'Auto-paused after 3 consecutive failures'
    });
  }
  

  await supabase
    .from('inboxes')
    .update(update)
    .eq('id', inbox_id);

    await supabase.rpc('increment_inbox_failed', {
        inbox_id_param: inbox_id
      });
      
}
