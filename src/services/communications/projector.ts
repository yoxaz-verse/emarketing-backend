import { randomUUID } from 'crypto';
import { supabase as defaultDb } from '../../supabase';
import { messageId, scopeForEvent } from './model';

export function createCommunicationProjector(db: any = defaultDb) {
async function result(query: any): Promise<any> { const {data,error}=await query; if(error) throw error; return data; }
async function row(table: string, id: string) { return id ? result(db.from(table).select('*').eq('id',id).maybeSingle()) : null; }
async function unique(table: string, column: string, value: string) {
  if(!value) return null;
  const rows=await result(db.from(table).select('*').eq(column,value).limit(2));
  return rows?.length===1 ? rows[0] : null;
}
async function projectEmail(q: any) {
  const r=q.payload; const inbound=q.source_table==='reply_ingest_events';
  const inbox=inbound ? await unique('inboxes','email_address',String(r.inbox_email || '').toLowerCase()) : await row('inboxes',r.inbox_id);
  const own=messageId(inbound ? r.own_message_id : r.provider_message_id);
  // Historical reply.message_id may be the parent's ID: never pretend it is the inbound ID.
  const parent=messageId(inbound ? r.in_reply_to || (!r.own_message_id ? r.message_id : null) : null);
  const recipient=String(inbound ? r.from_email || '' : r.to_email || '').toLowerCase();
  const sourceKey=`${q.source_table}:${q.source_id}`;
  // Replaying a completed append is a no-op; its feed update was in the same transaction.
  if(await unique('communication_messages','source_key',sourceKey)) return;
  let conversation:any=null;
  if(inbound && inbox) {
    const parents=[...new Set([parent,...(Array.isArray(r.reference_ids)?r.reference_ids:[]).slice().reverse(),r.message_id].map(messageId).filter(Boolean))];
    for(const reference of parents) {
      let candidates=await result(db.from('communication_messages').select('conversation_id').eq('message_id',reference).limit(101));
      // Resolve originals even if an incoming reply reached the queue first.
      if(!candidates.length) {
        const originals=await result(db.from('email_logs').select('*').eq('provider_message_id',reference).eq('inbox_id',inbox.id).eq('to_email',recipient).limit(2));
        if(originals.length===1) {
          await projectEmail({source_table:'email_logs',source_id:String(originals[0].id),payload:originals[0],created_at:q.created_at,historical:true});
          candidates=await result(db.from('communication_messages').select('conversation_id').eq('message_id',reference).limit(101));
        }
      }
      if(candidates.length>100) break; // Never infer uniqueness from a truncated result.
      const matching=new Map<string,any>();
      for(const candidate of candidates) {
        const c=await row('communication_conversations',candidate.conversation_id);
        if(c?.inbox_id===String(inbox.id) && c.recipient===recipient) matching.set(c.id,c);
      }
      if(matching.size>1) break; // Ambiguous parent: keep the reply independent.
      if(matching.size===1) {conversation=[...matching.values()][0];break;}
    }
  }
  const item=conversation ? await row('communication_items',conversation.id) : null;
  const occurred=r.received_at || r.sent_at || r.created_at || q.created_at;
  const campaign=conversation?.campaign_id || (!inbound ? r.campaign_id : null);
  const subject=String(r.subject || conversation?.subject || 'Email conversation');
  await result(db.rpc('communication_append', {
    p_item:item || {id:randomUUID(),source_key:sourceKey,
      scope_table:campaign?'campaigns':inbox?'inboxes':null,
      scope_id:campaign?String(campaign):inbox?String(inbox.id):null,title:subject},
    p_conversation:conversation || {inbox_id:inbox?String(inbox.id):null,recipient:recipient||null,campaign_id:campaign?String(campaign):null,subject},
    p_message:{source_key:sourceKey,direction:inbound?'inbound':'outbound',sender:inbound?r.from_email:inbox?.email_address,
      recipient:inbound?r.inbox_email:r.to_email,subject,body:inbound?r.message:r.body,message_id:own,in_reply_to:parent,
      reference_ids:(Array.isArray(r.reference_ids)?r.reference_ids:[]).map(messageId).filter(Boolean),occurred_at:occurred,status:inbound?'received':r.status||'sent'},
    p_historical:q.historical
  }));
}
async function project(q:any) {
  if(['reply_ingest_events','email_logs'].includes(q.source_table)) return projectEmail(q);
  const r=q.payload;
  let scope:any; let title:string; let preview:string;
  if(q.source_table==='system_events') {
    // Replies already have their own conversation item.
    if(['LEAD_REPLIED','UNMATCHED_REPLY_RECEIVED'].includes(r.type)) return;
    scope=scopeForEvent(r);title=String(r.type || 'System update').replace(/_/g,' ');preview=String(r.message || '');
  } else {
    const social=q.source_table==='social_publish_jobs'; const voice=q.source_table==='voice_calls';
    scope={source:social?'social':voice?'voice':'agent',module:social?'social_media':voice?'admin':'openflow_ai',
      scope_table:voice?null:q.source_table,scope_id:voice?null:q.source_id,
      href:social?'/dashboard/social-scheduling':voice?'/dashboard/voice-agents':'/dashboard/agent-integrations'};
    title=`${social ? r.platform_code || 'Social post' : voice ? 'Voice call' : r.title || r.task_type || r.type || 'Agent task'} · ${r.outcome || r.status || 'updated'}`;
    preview=String(r.error_message || r.last_error || r.summary || r.description || '');
  }
  await result(db.from('communication_items').upsert({source_key:`${q.source_table}:${q.source_id}`,kind:'notification',...scope,title,preview:preview.slice(0,400),
    occurred_at:r.updated_at || r.created_at || q.created_at,activity_at:q.created_at,historical:q.historical},{onConflict:'source_key'}));
}
let running=false;
async function reconcileCommunications() {
  if(running) return; running=true;
  const owner=randomUUID(); let leased=false;
  try {
    leased=await result(db.rpc('communication_lease',{p_owner:owner}));
    if(!leased) return;
    const queue=await result(db.from('communication_queue').select('*').order('id').limit(100));
    // Outgoing originals precede incoming historical replies so threading can resolve.
    queue.sort((a:any,b:any)=>Number(b.source_table==='email_logs')-Number(a.source_table==='email_logs') || Number(a.id)-Number(b.id));
    for(const q of queue) {
      if(!await result(db.rpc('communication_lease',{p_owner:owner}))) throw new Error('Projection lease expired');
      await project(q); await result(db.from('communication_queue').delete().eq('id',q.id));
    }
    const {count,error}=await db.from('communication_queue').select('id',{count:'exact',head:true}).eq('historical',true);
    if(error) throw error;
    if(count===0) await result(db.from('communication_state').update({ready:true}).eq('id',true));
    const abandoned=await result(db.from('communication_messages').select('id').eq('status','pending').lt('occurred_at',new Date(Date.now()-5*60_000).toISOString()).limit(100));
    for(const attempt of abandoned) await result(db.rpc('communication_finish_send',{p_id:attempt.id,p_status:'uncertain'}));
  } finally {
    try {if(leased) await result(db.rpc('communication_lease',{p_owner:owner,p_release:true}));}
    finally {running=false;}
  }
}
function startCommunicationRunner() {
  const tick=()=>reconcileCommunications().catch((error:any)=>console.error('[COMMUNICATIONS_RECONCILE]',error.code || '',error.message));
  void tick(); const timer=setInterval(tick,5000); timer.unref();
}

return {project, reconcileCommunications, startCommunicationRunner};
}
const runner=createCommunicationProjector();
export const reconcileCommunications=runner.reconcileCommunications;
export const startCommunicationRunner=runner.startCommunicationRunner;
