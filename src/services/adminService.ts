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
  const { data: activeUsers, error: activeUsersError } = await supabase
    .from('users')
    .select('operator_id')
    .eq('active', true)
    .not('operator_id', 'is', null);

  if (activeUsersError) {
    return { data: null, error: activeUsersError };
  }

  const operatorIds = Array.from(
    new Set(
      (Array.isArray(activeUsers) ? activeUsers : [])
        .map((row: any) => String(row?.operator_id ?? '').trim())
        .filter(Boolean)
    )
  );

  if (operatorIds.length === 0) {
    return { data: [], error: null };
  }

  const { data, error } = await supabase
    .from('operators')
    .select('id, name, region')
    .in('id', operatorIds)
    .order('name', { ascending: true });

  return { data: data ?? [], error };
}
