import { randomUUID } from 'crypto';
import { supabase as db } from '../../supabase';
import { messageId, scopeForEvent } from './model';

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
  let conversation:any=null;
  if(inbound && inbox && parent) {
    const candidates=await result(db.from('communication_messages').select('conversation_id').eq('message_id',parent).limit(20));
    for(const candidate of candidates || []) {
      const c=await row('communication_conversations',candidate.conversation_id);
      if(c?.inbox_id===String(inbox.id) && c.recipient===recipient) {
        if(conversation && conversation.id!==c.id) {conversation=null; break;}
        conversation=c;
      }
    }
  }
  // Group only by verified parent identity or exact original campaign log. No sender-only matching.
  const sourceKey=`${q.source_table}:${q.source_id}`;
  let item:any=conversation ? await row('communication_items',conversation.id) : await unique('communication_items','source_key',sourceKey);
  const occurred=r.received_at || r.sent_at || r.created_at || q.created_at;
  const campaign=conversation?.campaign_id || (!inbound ? r.campaign_id : null);
  const subject=r.subject || conversation?.subject || 'Email conversation';
  if(!item) item=await result(db.from('communication_items').upsert({source_key:sourceKey,kind:'message',source:'email',module:'marketing',
    scope_table:campaign ? 'campaigns' : inbox ? 'inboxes' : null,scope_id:campaign ? String(campaign) : inbox ? String(inbox.id) : null,
    title:subject,preview:String(inbound ? r.message || '' : r.body || '').slice(0,400),href:null,
    occurred_at:occurred,activity_at:q.created_at,historical:q.historical},{onConflict:'source_key'}).select().single());
  if(!conversation) conversation=await result(db.from('communication_conversations').upsert({id:item.id,inbox_id:inbox ? String(inbox.id) : null,
    recipient:recipient || null,campaign_id:campaign ? String(campaign) : null,subject},{onConflict:'id'}).select().single());
  await result(db.from('communication_messages').upsert({conversation_id:conversation.id,source_key:sourceKey,direction:inbound?'inbound':'outbound',
    sender:inbound ? r.from_email : inbox?.email_address,recipient:inbound ? r.inbox_email : r.to_email,subject,
    body:inbound ? r.message : r.body,message_id:own,in_reply_to:parent,reference_ids:(r.reference_ids || []).map(messageId).filter(Boolean),
    occurred_at:occurred,status:inbound?'received':r.status || 'sent'},{onConflict:'source_key',ignoreDuplicates:true}));
  // A historical record must never erase newer unread activity.
  if(new Date(occurred)>=new Date(item.occurred_at)) await result(db.from('communication_items').update({occurred_at:occurred,
    preview:String(inbound?r.message || '':r.body || '').slice(0,400),activity_at:q.created_at,historical: item.historical && q.historical}).eq('id',item.id));
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
export async function reconcileCommunications() {
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
    await result(db.from('communication_messages').update({status:'uncertain'}).eq('status','pending').lt('occurred_at',new Date(Date.now()-5*60_000).toISOString()));
  } finally {
    try {if(leased) await result(db.rpc('communication_lease',{p_owner:owner,p_release:true}));}
    finally {running=false;}
  }
}
export function startCommunicationRunner() {
  const tick=()=>reconcileCommunications().catch((error:any)=>console.error('[COMMUNICATIONS_RECONCILE]',error.code || '',error.message));
  void tick(); const timer=setInterval(tick,5000); timer.unref();
}
