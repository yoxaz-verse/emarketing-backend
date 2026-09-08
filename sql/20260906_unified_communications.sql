begin;
-- Service-only storage: all reads go through the authenticated Express API.
create table if not exists communication_queue (
 id bigserial primary key, source_table text not null, source_id text not null,
 payload jsonb not null, historical boolean not null default false,
 created_at timestamptz not null default now(), unique(source_table, source_id, created_at)
);
create unique index if not exists communication_queue_dedupe on communication_queue(source_table,source_id,md5(payload::text));
create table if not exists communication_items (
 id uuid primary key default gen_random_uuid(), source_key text not null unique,
 kind text not null check(kind in ('message','notification')), source text not null,
 module text not null, scope_table text, scope_id text,
 title text not null, preview text not null default '', href text,
 occurred_at timestamptz not null, activity_at timestamptz not null default now(),
 historical boolean not null default false
);
create index if not exists communication_items_order on communication_items(occurred_at desc,id desc);
create table if not exists communication_conversations (
 id uuid primary key references communication_items(id) on delete cascade,
 inbox_id text, recipient text, campaign_id text, subject text not null default ''
);
create table if not exists communication_messages (
 id uuid primary key default gen_random_uuid(), conversation_id uuid not null references communication_conversations(id) on delete cascade,
 source_key text not null unique, direction text not null, sender text, recipient text,
 subject text, body text, message_id text, in_reply_to text, reference_ids text[] not null default '{}',
 occurred_at timestamptz not null, status text not null default 'received',
 user_id text, idempotency_key text, unique(user_id,idempotency_key)
);
create index if not exists communication_messages_thread on communication_messages(conversation_id,occurred_at,id);
create index if not exists communication_messages_mid on communication_messages(message_id);
create table if not exists communication_reads (
 user_id text not null, item_id uuid not null references communication_items(id) on delete cascade,
 read_at timestamptz not null, primary key(user_id,item_id)
);
create table if not exists communication_state (
 id boolean primary key default true check(id), ready boolean not null default false, lease_owner text, lease_until timestamptz
);
insert into communication_state(id) values(true) on conflict do nothing;
-- Capture the actual inbound ID independently of its parent (legacy message_id was overloaded).
alter table reply_ingest_events add column if not exists own_message_id text;
alter table reply_ingest_events add column if not exists in_reply_to text;
alter table reply_ingest_events add column if not exists reference_ids text[];
alter table reply_ingest_events add column if not exists subject text;

create or replace function communication_lease(p_owner text,p_release boolean default false) returns boolean
language plpgsql security definer set search_path=public as $$
begin
 if p_release then
  update communication_state set lease_owner=null,lease_until=null where id and lease_owner=p_owner;
 else
  update communication_state set lease_owner=p_owner,lease_until=now()+interval '2 minutes'
  where id and (lease_owner=p_owner or lease_until is null or lease_until<now());
 end if;
 return found;
end $$;
create or replace function communication_capture() returns trigger language plpgsql security definer set search_path=public as $$
begin
 if TG_OP='UPDATE' and to_jsonb(old)=to_jsonb(new) then return new; end if;
 insert into communication_queue(source_table,source_id,payload)
 values(TG_TABLE_NAME,to_jsonb(new)->>'id',to_jsonb(new)) on conflict do nothing;
 return new;
end $$;
do $$ declare t text; begin
 foreach t in array array['email_logs','reply_ingest_events','system_events','social_publish_jobs','voice_calls','agent_tasks'] loop
  if to_regclass('public.'||t) is not null then
   execute format('drop trigger if exists communication_capture on %I',t);
   execute format('create trigger communication_capture after insert or update on %I for each row execute function communication_capture()',t);
   -- Queue survives restarts. Only seed on the first installation.
   if not (select ready from communication_state where id) then
    execute format('insert into communication_queue(source_table,source_id,payload,historical) select %L,id::text,to_jsonb(s),true from %I s on conflict do nothing',t,t);
   end if;
  end if;
 end loop;
end $$;

-- Resolve current ownership, including reassignment/deletion, instead of trusting cached scopes.
create or replace function communication_allowed(p_user text,p_item communication_items) returns boolean
language plpgsql stable security definer set search_path=public as $$
declare u jsonb; r jsonb; begin
 select to_jsonb(x) into u from users x where id::text=p_user;
 if u is null or coalesce((u->>'active')::boolean,false)=false then return false; end if;
 if u->>'role' in ('admin','superadmin') then return true; end if;
 if p_item.module='admin' or coalesce(u->'access_flags'->>p_item.module,'false') not in ('true','1','yes','on') then return false; end if;
 if p_item.scope_table is null or p_item.scope_id is null or coalesce(u->>'operator_id','')='' then return false; end if;
 if p_item.scope_table not in ('campaigns','inboxes','leads','social_publish_jobs','agent_tasks') then return false; end if;
 execute format('select to_jsonb(x) from %I x where id::text=$1',p_item.scope_table) into r using p_item.scope_id;
 return coalesce(r->>'operator_id','')=u->>'operator_id';
end $$;
create or replace function communication_list(p_user text,p_kind text default '',p_source text default '',p_search text default '',p_unread boolean default false,p_page int default 1,p_limit int default 30,p_id uuid default null)
returns jsonb language sql stable security definer set search_path=public as $$
 with visible as (
 select i.*, (not i.historical and coalesce(r.read_at,'-infinity'::timestamptz)<i.activity_at) as unread
 from communication_items i left join communication_reads r on r.item_id=i.id and r.user_id=p_user
 where communication_allowed(p_user,i)
 ), filtered as (
 select * from visible where (p_kind='' or kind=p_kind) and (p_source='' or source=p_source)
 and (p_id is null or id=p_id) and (not p_unread or unread)
 and (p_search='' or strpos(lower(title||' '||preview),lower(p_search))>0
 or exists(select 1 from communication_messages m where m.conversation_id=visible.id and strpos(lower(coalesce(m.body,'')||' '||coalesce(m.sender,'')||' '||coalesce(m.recipient,'')),lower(p_search))>0))
 ), paged as (select * from filtered order by occurred_at desc,id desc limit least(greatest(p_limit,1),100) offset (greatest(p_page,1)-1)*least(greatest(p_limit,1),100))
 select jsonb_build_object('items',coalesce((select jsonb_agg(to_jsonb(p)) from paged p),'[]'::jsonb),
 'total',(select count(*) from filtered),'unread_count',(select count(*) from visible where unread),'as_of',now());
$$;
create or replace function communication_mark_read(p_user text,p_ids uuid[],p_before timestamptz) returns void
language sql security definer set search_path=public as $$
 insert into communication_reads(user_id,item_id,read_at)
 select p_user,i.id,least(p_before,now()) from communication_items i
 where communication_allowed(p_user,i) and (p_ids is null or i.id=any(p_ids)) and i.activity_at<=least(p_before,now())
 on conflict(user_id,item_id) do update set read_at=greatest(communication_reads.read_at,excluded.read_at);
$$;
do $$ declare t text; f record; begin
 foreach t in array array['communication_queue','communication_items','communication_conversations','communication_messages','communication_reads','communication_state'] loop
 execute format('alter table %I enable row level security',t);
 execute format('revoke all on %I from anon,authenticated',t);
 execute format('grant all on %I to service_role',t);
 end loop;
 for f in select oid::regprocedure as signature from pg_proc where pronamespace='public'::regnamespace and proname in ('communication_allowed','communication_list','communication_mark_read','communication_capture','communication_lease') loop
 execute format('revoke all on function %s from public,anon,authenticated',f.signature);
 execute format('grant execute on function %s to service_role',f.signature);
 end loop;
end $$;
grant usage,select on sequence communication_queue_id_seq to service_role;
commit;
