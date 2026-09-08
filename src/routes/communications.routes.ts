import { Router } from 'express';
import crypto from 'crypto';
import validator from 'validator';
import { supabase as db } from '../supabase';
import { requireAuth } from '../middleware/requireAuth';
import { requireWriteRole, rateLimit } from '../middleware/security';
import { createSmtpTransport } from '../services/email/smtpTransport';
import { decryptSecret } from '../utils/sendEncryption';
import { messageId, replySubject, sendFailureStatus } from '../services/communications/model';

const router=Router();
router.use(requireAuth('viewer'));
router.use((_req,res,next)=>{res.setHeader('Cache-Control','no-store');next();});
const fail=(message:string,status=400)=>Object.assign(new Error(message),{status});
async function result(q:any):Promise<any> {const {data,error}=await q;if(error)throw error;return data;}
const handle=(fn:any)=>(req:any,res:any)=>Promise.resolve(fn(req,res)).catch((error:any)=>{
  console.error('[COMMUNICATIONS_API]',error.code || '',error.message);
  res.status(error.status || 500).json({error:error.status ? error.message : 'Communication request failed. Please retry.'});
});
// Explicit next-based middleware: no API-key access to personal read state.
router.use(async(req,res,next)=>{
  if(req.auth?.type!=='user' || !req.auth.user_id) {res.status(403).json({error:'User sign-in required'});return;}
  try {
    const state=await result(db.from('communication_state').select('ready').eq('id',true).maybeSingle());
    if(!state?.ready) {res.status(409).json({error:'Communication history is being prepared. Please retry shortly.'});return;}
    next();
  } catch {res.status(409).json({error:'Communications requires the database migration and history import.'});}
});
function id(value:string) {if(!validator.isUUID(value)) throw fail('Invalid item ID');return value;}
async function visible(user:string,itemId:string) {
  const data=await result(db.rpc('communication_list',{p_user:user,p_id:id(itemId)}));
  if(!data.items?.[0]) throw fail('Communication not found',404);
  return data.items[0];
}
router.get('/',handle(async(req:any,res:any)=>{
  const kind=String(req.query.kind || ''),source=String(req.query.source || ''),search=String(req.query.search || '');
  if(!['','message','notification'].includes(kind) || !['','email','campaign','social','voice','agent','system'].includes(source) || search.length>200) throw fail('Invalid filters');
  const page=Number(req.query.page || 1),limit=Number(req.query.limit || 30);
  if(!Number.isInteger(page)||page<1||page>100000||!Number.isInteger(limit)||limit<1||limit>100) throw fail('Invalid pagination');
  res.json(await result(db.rpc('communication_list',{p_user:req.auth.user_id,p_kind:kind,p_source:source,p_search:search,p_unread:req.query.unread==='true',p_page:page,p_limit:limit})));
}));
router.get('/unread-count',handle(async(req:any,res:any)=>{
  const data=await result(db.rpc('communication_list',{p_user:req.auth.user_id,p_limit:1}));res.json({unread_count:data.unread_count,as_of:data.as_of});
}));
router.post('/read',handle(async(req:any,res:any)=>{
  const ids=req.body?.ids;
  if(ids!==null && (!Array.isArray(ids)||ids.length>100||ids.some((x:any)=>typeof x!=='string'||!validator.isUUID(x)))) throw fail('Supply item IDs, or null for all');
  const before=String(req.body?.before || '');if(!validator.isISO8601(before))throw fail('Read timestamp required');
  await result(db.rpc('communication_mark_read',{p_user:req.auth.user_id,p_ids:ids,p_before:before}));res.json({success:true});
}));
async function mailbox(c:any) {
  if(!c?.inbox_id || !validator.isEmail(c.recipient || '')) return null;
  const inbox=await result(db.from('inboxes').select('*').eq('id',c.inbox_id).maybeSingle());
  if(!inbox?.smtp_account_id || inbox.active===false || ['disabled','retired','inactive','paused'].includes(inbox.status)) return null;
  const smtp=await result(db.from('smtp_accounts').select('*').eq('id',inbox.smtp_account_id).maybeSingle());
  if(!smtp?.host || !smtp?.password || !smtp?.username || smtp.active===false || ['disabled','retired','inactive'].includes(smtp.status)) return null;
  return {inbox,smtp};
}
router.get('/:id',handle(async(req:any,res:any)=>{
  const item=await visible(req.auth.user_id,req.params.id);
  const conversation=await result(db.from('communication_conversations').select('*').eq('id',item.id).maybeSingle());
  const messages=conversation ? await result(db.from('communication_messages').select('id,direction,sender,recipient,subject,body,occurred_at,status').eq('conversation_id',item.id).order('occurred_at').order('id')) : [];
  const available=conversation ? Boolean(await mailbox(conversation)) : false;
  res.json({item,conversation,messages,can_reply:available && req.auth.role!=='viewer',reply_disabled_reason:!conversation?null:req.auth.role==='viewer'?'Your role has read-only access.':!available?'The original mailbox is unavailable or the sender address is missing.':null,as_of:new Date().toISOString()});
}));
router.post('/:id/reply',requireWriteRole,rateLimit({name:'communication-reply',windowMs:60_000,max:15}),handle(async(req:any,res:any)=>{
  const item=await visible(req.auth.user_id,req.params.id);
  const text=String(req.body?.body || '').trim(),key=String(req.body?.idempotency_key || '');
  if(!text || text.length>50000 || !validator.isUUID(key))throw fail('A reply (up to 50,000 characters) and UUID idempotency key are required');
  const existing=await result(db.from('communication_messages').select('id,status,conversation_id,body').eq('user_id',req.auth.user_id).eq('idempotency_key',key).maybeSingle());
  if(existing) {
    if(existing.conversation_id!==item.id || existing.body!==text)throw fail('Idempotency key already used for a different reply',409);
    res.json({id:existing.id,status:existing.status});return;
  }
  const c=await result(db.from('communication_conversations').select('*').eq('id',item.id).maybeSingle());
  const account=await mailbox(c);if(!account)throw fail('Original mailbox unavailable',409);
  const {inbox,smtp}=account;
  // A campaign can use a shared mailbox, but never a mailbox owned by another operator.
  if(!['admin','superadmin'].includes(req.auth.role) && inbox.operator_id && String(inbox.operator_id)!==String(req.auth.operator_id))throw fail('Mailbox not available',403);
  const history=await result(db.from('communication_messages').select('message_id,reference_ids').eq('conversation_id',item.id).order('occurred_at',{ascending:false}).limit(100));
  const parent=history.find((m:any)=>messageId(m.message_id));
  const refs=[...new Set<string>([...(parent?.reference_ids || []),parent?.message_id].map(messageId).filter(Boolean) as string[])].slice(-50);
  const msgId=`${crypto.randomUUID()}@${String(inbox.email_address).split('@')[1]}`;
  const subject=replySubject(c.subject);
  // Decrypt/configure before reserving a send. After reservation, ambiguous failures stay uncertain.
  const transport=createSmtpTransport({...smtp,password:decryptSecret(smtp.password)}, undefined, {connectionTimeout:15000,greetingTimeout:15000,socketTimeout:45000});
  const at=new Date().toISOString();
  const {data:attempt,error}=await db.from('communication_messages').insert({conversation_id:item.id,source_key:`reply:${req.auth.user_id}:${key}`,direction:'outbound',
    sender:inbox.email_address,recipient:c.recipient,subject,body:text,message_id:msgId,in_reply_to:parent?.message_id || null,reference_ids:refs,
    occurred_at:at,status:'pending',user_id:req.auth.user_id,idempotency_key:key}).select('id,status').single();
  if(error) {if(error.code==='23505')throw fail('Reply already submitted. Refresh the conversation to see its status.',409);throw error;}
  let status='uncertain';
  try {
    const info=await transport.sendMail({from:inbox.email_address,to:c.recipient,subject,text,messageId:`<${msgId}>`,
      inReplyTo:parent?.message_id?`<${parent.message_id}>`:undefined,references:refs.map(x=>`<${x}>`)});
    status=info.accepted?.length ? 'sent' : 'failed';
  } catch(error:any) {status=sendFailureStatus(error);} finally {transport.close();}
  await result(db.from('communication_messages').update({status}).eq('id',attempt.id));
  await result(db.from('communication_items').update({preview:text.slice(0,400),occurred_at:at,activity_at:at,historical:false}).eq('id',item.id));
  res.json({id:attempt.id,status});
}));
export default router;
