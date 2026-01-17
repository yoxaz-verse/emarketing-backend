import { supabase } from '../supabase.js';

export async function pauseInbox(inboxId: string, reason?: string) {
  await supabase
    .from('inboxes')
    .update({
      status: 'paused',
      paused_reason: reason ?? 'Paused manually',
      hard_paused: false
    })
    .eq('id', inboxId);

    await supabase.from('system_events').insert({
        type: 'ADMIN_ACTION',
        entity: 'inbox',
        entity_id: inboxId,
        message: 'Inbox manually paused'
      });
      
}

export async function hardPauseInbox(inboxId: string, reason?: string) {
  await supabase
    .from('inboxes')
    .update({
      status: 'paused',
      hard_paused: true,
      hard_paused_reason: reason ?? 'Hard paused manually'
    })
    .eq('id', inboxId);

    await supabase.from('system_events').insert({
        type: 'ADMIN_ACTION',
        entity: 'inbox',
        entity_id: inboxId,
        message: 'Inbox manually hard paused'
      });
      
}

export async function resumeInbox(inboxId: string) {
  await supabase
    .from('inboxes')
    .update({
      status: 'active',
      paused_reason: null,
      hard_paused: false,
      hard_paused_reason: null
    })
    .eq('id', inboxId);

    await supabase.from('system_events').insert({
        type: 'ADMIN_ACTION',
        entity: 'inbox',
        entity_id: inboxId,
        message: 'Inbox manually resumed'
      });


      
}

export async function disableSequence(sequenceId: string) {

  console.log("Backend disableSequence Called");
  
  await supabase
    .from('sequences')
    .update({ is_active: false })
    .eq('id', sequenceId);

    await supabase.from('system_events').insert({
        type: 'ADMIN_ACTION',
        entity: 'sequence',
        entity_id: sequenceId,
        message: 'Sequence manually disabled'
      });
      

    
}

export async function enableSequence(sequenceId: string) {
  await supabase
    .from('sequences')
    .update({ is_active: true })
    .eq('id', sequenceId);

    await supabase.from('system_events').insert({
        type: 'ADMIN_ACTION',
        entity: 'sequence',
        entity_id: sequenceId,
        message: 'Sequence manually enabled'
      });
      
}


export async function listOperators() {
  return supabase.from('operators').select('id, name, region');
}

