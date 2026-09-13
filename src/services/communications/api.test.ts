import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
process.env.SUPABASE_URL ||= 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';
process.env.REDIS_URL='';
const itemId='10000000-0000-4000-8000-000000000001';
const key='20000000-0000-4000-8000-000000000001';
const {createCommunicationsRouter}: typeof import('../../routes/communications.routes')=require('../../routes/communications.routes');

// The in-memory adapter records mail effects and implements the persistence contract.
function fixture(options:{role?:string;visible?:boolean;mailbox?:boolean;sendError?:object;wrongMailboxOwner?:boolean}={}) {
  const messages:any[]=[];let sends=0;let sentOptions:any;
  const tables:Record<string,any[]>={
    communication_state:[{ready:true,id:true}],communication_messages:messages,
    communication_items:[{id:itemId,kind:'message',activity_at:'2026-09-01T00:00:00Z'}],
    communication_conversations:[{id:itemId,inbox_id:'box',recipient:'recipient@example.com',subject:'Question'}],
    inboxes:options.mailbox===false?[]:[{id:'box',operator_id:options.wrongMailboxOwner?'other':'op',email_address:'sender@example.com',smtp_account_id:'smtp'}],
    smtp_accounts:[{id:'smtp',host:'smtp.example.com',port:465,username:'sender',password:'encrypted'}],
  };
  const database={
    rpc:async(name:string)=>({data:name==='communication_list'?{items:options.visible===false?[]:[tables.communication_items[0]],as_of:'2026-09-01T01:00:00Z'}:null,error:null}),
    from:(table:string)=>{
      let filters:Array<(r:any)=>boolean>=[];let insert:any=null;let update:any=null;let single=false;
      const query:any={
        select:()=>query,eq:(k:string,v:any)=>{filters.push(r=>r[k]===v);return query;},in:(k:string,v:any[])=>{filters.push(r=>v.includes(r[k]));return query;},
        order:()=>query,limit:()=>query,maybeSingle:()=>{single=true;return query;},single:()=>{single=true;return query;},
        insert:(r:any)=>{insert=r;return query;},update:(r:any)=>{update=r;return query;},
        then:(resolve:any)=>{
          const rows=tables[table]||[];let selected=rows.filter(r=>filters.every(f=>f(r)));
          if(insert){const duplicate=rows.find(r=>r.idempotency_key===insert.idempotency_key);if(duplicate)return Promise.resolve({data:null,error:{code:'23505'}}).then(resolve);const r={id:'attempt',...insert};rows.push(r);selected=[r];}
          if(update)selected.forEach(r=>Object.assign(r,update));
          return Promise.resolve({data:single?selected[0]||null:selected,error:null}).then(resolve);
        }
      };return query;
    }
  };
  const router=createCommunicationsRouter({database:database as any,authenticate:(req,_res,next)=>{req.auth={type:'user',user_id:'u',role:(options.role||'user') as any,operator_id:'op'};next();},
    decrypt:x=>x,transport:(()=>({sendMail:async(mail:any)=>{sends++;sentOptions=mail;if(options.sendError)throw options.sendError;return {accepted:['recipient@example.com']};},close:()=>{}})) as any});
  return {router,messages,get sends(){return sends;},get mail(){return sentOptions;}};
}
async function withServer(f:ReturnType<typeof fixture>,run:(url:string)=>Promise<void>) {
  const app=express();app.use(express.json());app.use('/communications',f.router);
  const server=app.listen(0,'127.0.0.1');
  await new Promise<void>(resolve=>server.once('listening',resolve));
  try{await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}/communications`);}
  finally{server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}
}
const reply=(url:string,body='A reply')=>fetch(`${url}/${itemId}/reply`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({body,idempotency_key:key})});
test('viewer can read but cannot send',async()=>{
  const f=fixture({role:'viewer'});await withServer(f,async url=>{const d=await (await fetch(`${url}/${itemId}`)).json();assert.equal(d.can_reply,false);assert.equal((await reply(url)).status,403);assert.equal(f.sends,0);});
});
test('inaccessible conversation and unavailable mailbox cannot send',async()=>{
  for(const config of [{visible:false},{mailbox:false},{wrongMailboxOwner:true}]){const f=fixture(config);await withServer(f,async url=>{assert.ok((await reply(url)).status>=400);assert.equal(f.sends,0);});}
});
test('same idempotency key submits mail once and changed body conflicts',async()=>{
  const f=fixture();await withServer(f,async url=>{assert.equal((await reply(url)).status,200);assert.equal((await reply(url)).status,200);assert.equal((await reply(url,'different')).status,409);assert.equal(f.sends,1);assert.equal(f.mail.from,'sender@example.com');assert.equal(f.mail.to,'recipient@example.com');assert.equal(f.mail.text,'A reply');assert.equal(f.messages[0].status,'sent');});
});
test('uncertain SMTP result is retained and never automatically resubmitted',async()=>{
  const f=fixture({sendError:{code:'ETIMEDOUT'}});await withServer(f,async url=>{assert.equal((await (await reply(url)).json()).status,'uncertain');await reply(url);assert.equal(f.sends,1);assert.equal(f.messages[0].status,'uncertain');});
});
test('reply headers use the latest delivered parent, excluding failed attempts',async()=>{
  const f=fixture();f.messages.push({id:'received',conversation_id:itemId,status:'received',message_id:'Actual-ID@example.com',reference_ids:['Original@example.com']},{id:'failed',conversation_id:itemId,status:'failed',message_id:'Failed@example.com'});
  await withServer(f,async url=>{await reply(url);assert.equal(f.mail.inReplyTo,'<Actual-ID@example.com>');assert.deepEqual(f.mail.references,['<Original@example.com>','<Actual-ID@example.com>']);});
});
