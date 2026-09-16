begin;

-- In-flight projector work may outlive a queue snapshot. Never re-create a
-- campaign-scoped feed item once the campaign has been removed.
create or replace function communication_reject_deleted_campaign() returns trigger
language plpgsql security definer set search_path=public as $$
begin
  if new.scope_table='campaigns' and new.scope_id is not null and not exists
    (select 1 from campaigns where id::text=new.scope_id for key share) then
    return null;
  end if;
  return new;
end $$;
drop trigger if exists communication_reject_deleted_campaign on communication_items;
create trigger communication_reject_deleted_campaign before insert or update on communication_items
for each row execute function communication_reject_deleted_campaign();

do $$
begin
  if to_regprocedure('public.communication_append_unchecked(jsonb,jsonb,jsonb,boolean)') is null then
    alter function communication_append(jsonb,jsonb,jsonb,boolean) rename to communication_append_unchecked;
  end if;
end $$;
create function communication_append(p_item jsonb,p_conversation jsonb,p_message jsonb,p_historical boolean)
returns void language plpgsql security definer set search_path=public as $$
begin
  if p_conversation->>'campaign_id' is not null and not exists
    (select 1 from campaigns where id::text=p_conversation->>'campaign_id' for key share) then
    return;
  end if;
  perform communication_append_unchecked(p_item,p_conversation,p_message,p_historical);
end $$;
revoke all on function communication_append_unchecked(jsonb,jsonb,jsonb,boolean) from public,anon,authenticated;
revoke all on function communication_append(jsonb,jsonb,jsonb,boolean) from public,anon,authenticated;
grant execute on function communication_append(jsonb,jsonb,jsonb,boolean) to service_role;

-- These functions are service-role only. Each invocation is one PostgreSQL transaction.
create or replace function campaign_delete_preview(p_campaign_id text, p_operator_id text default null)
returns jsonb language plpgsql security definer set search_path=public as $$
declare c campaigns%rowtype; d jsonb; n bigint; t text;
begin
  select * into c from campaigns where id::text=p_campaign_id;
  if not found or (p_operator_id is not null and c.operator_id::text is distinct from p_operator_id) then
    raise exception 'Campaign not found' using errcode='P0002';
  end if;
  d:=jsonb_build_object('campaigns',1);
  foreach t in array array['campaign_leads','campaign_inboxes','campaign_voice_agents','voice_calls'] loop
    execute format('select count(*) from %I where campaign_id::text=$1',t) into n using p_campaign_id;
    d:=d||jsonb_build_object(t,n);
  end loop;
  select count(*) into n from email_logs e where e.campaign_id::text=p_campaign_id
    or e.campaign_lead_id::text in (select id::text from campaign_leads where campaign_id::text=p_campaign_id);
  d:=d||jsonb_build_object('email_logs',n);
  select count(*) into n from email_tracking_events e where e.campaign_id::text=p_campaign_id
    or e.campaign_lead_id::text in (select id::text from campaign_leads where campaign_id::text=p_campaign_id);
  d:=d||jsonb_build_object('email_tracking_events',n);
  select count(*) into n from system_events where (entity_id::text=p_campaign_id and entity in ('campaign','campaigns'))
    or to_jsonb(system_events)->'meta'->>'campaign_id'=p_campaign_id;
  d:=d||jsonb_build_object('system_events',n);
  select count(*) into n from reply_ingest_events r where exists
    (select 1 from communication_messages m join communication_conversations x on x.id=m.conversation_id
     where m.source_key='reply_ingest_events:'||r.id::text and x.campaign_id=p_campaign_id);
  d:=d||jsonb_build_object('reply_ingest_events',n);
  select count(*) into n from communication_conversations where campaign_id=p_campaign_id;
  d:=d||jsonb_build_object('communication_conversations',n);
  select count(*) into n from communication_messages m join communication_conversations x on x.id=m.conversation_id where x.campaign_id=p_campaign_id;
  d:=d||jsonb_build_object('communication_messages',n);
  select count(*) into n from communication_items i where (i.scope_table='campaigns' and i.scope_id=p_campaign_id)
    or exists(select 1 from communication_conversations x where x.id=i.id and x.campaign_id=p_campaign_id);
  d:=d||jsonb_build_object('communication_items',n);
  select count(*) into n from communication_queue q where q.payload->>'campaign_id'=p_campaign_id
    or q.payload->'meta'->>'campaign_id'=p_campaign_id
    or (q.source_table='system_events' and q.payload->>'entity_id'=p_campaign_id and q.payload->>'entity' in ('campaign','campaigns'))
    or (q.source_table='email_logs' and exists
      (select 1 from email_logs e where e.id::text=q.source_id and e.campaign_id::text=p_campaign_id))
    or (q.source_table='voice_calls' and exists
      (select 1 from voice_calls v where v.id::text=q.source_id and v.campaign_id::text=p_campaign_id))
    or (q.source_table='reply_ingest_events' and exists
      (select 1 from communication_messages m join communication_conversations x on x.id=m.conversation_id
       where m.source_key='reply_ingest_events:'||q.source_id and x.campaign_id=p_campaign_id));
  d:=d||jsonb_build_object('communication_queue',n);
  return jsonb_build_object(
    'campaign',jsonb_build_object('id',c.id,'name',c.name,'status',c.status),
    'canDelete',lower(trim(coalesce(c.status::text,'')))<>'running',
    'blocker',case when lower(trim(coalesce(c.status::text,'')))='running' then 'Pause this campaign before deleting.' else null end,
    'deletes',d,
    'preserves',jsonb_build_array('leads','inboxes','voice_agents','sequences','operators','users'));
end $$;

create or replace function delete_campaigns_with_data(p_campaign_ids text[], p_operator_id text default null)
returns integer language plpgsql security definer set search_path=public as $$
declare ids text[]; found_count integer; running_name text;
begin
  select array_agg(distinct trim(x)) into ids from unnest(p_campaign_ids) x where trim(x)<>'';
  if ids is null then return 0; end if;
  -- Lock all target rows before any writes. FK inserts and concurrent deletes serialize here.
  perform 1 from campaigns where id::text=any(ids) order by id for update;
  select count(*) into found_count from campaigns where id::text=any(ids)
    and (p_operator_id is null or operator_id::text=p_operator_id);
  if found_count<>cardinality(ids) then
    raise exception 'Campaign not found or outside your operator scope' using errcode='P0002';
  end if;
  select name into running_name from campaigns where id::text=any(ids)
    and lower(trim(coalesce(status::text,'')))='running' limit 1;
  if found then
    raise exception 'Pause campaign "%" before deleting.',running_name using errcode='P0001';
  end if;

  -- Drop pending projections before deleting source rows; the worker also checks
  -- campaign existence before projecting an item it already loaded.
  delete from communication_queue q where q.payload->>'campaign_id'=any(ids)
    or q.payload->'meta'->>'campaign_id'=any(ids)
    or (q.source_table='system_events' and q.payload->>'entity_id'=any(ids) and q.payload->>'entity' in ('campaign','campaigns'))
    or (q.source_table='email_logs' and exists
      (select 1 from email_logs e where e.id::text=q.source_id and e.campaign_id::text=any(ids)))
    or (q.source_table='voice_calls' and exists
      (select 1 from voice_calls v where v.id::text=q.source_id and v.campaign_id::text=any(ids)))
    or (q.source_table='reply_ingest_events' and exists
      (select 1 from communication_messages m join communication_conversations x on x.id=m.conversation_id
       where m.source_key='reply_ingest_events:'||q.source_id and x.campaign_id=any(ids)));

  delete from reply_ingest_events r where exists
    (select 1 from communication_messages m join communication_conversations x on x.id=m.conversation_id
     where m.source_key='reply_ingest_events:'||r.id::text and x.campaign_id=any(ids));
  -- Deleting the feed parent cascades to messages and read markers.
  delete from communication_items i where (i.scope_table='campaigns' and i.scope_id=any(ids))
    or exists(select 1 from communication_conversations x where x.id=i.id and x.campaign_id=any(ids));
  delete from email_tracking_events where campaign_id::text=any(ids)
    or campaign_lead_id::text in (select id::text from campaign_leads where campaign_id::text=any(ids));
  delete from email_logs where campaign_id::text=any(ids)
    or campaign_lead_id::text in (select id::text from campaign_leads where campaign_id::text=any(ids));
  delete from voice_calls where campaign_id::text=any(ids);
  delete from campaign_voice_agents where campaign_id::text=any(ids);
  delete from campaign_inboxes where campaign_id::text=any(ids);
  delete from campaign_leads where campaign_id::text=any(ids);
  delete from system_events where (entity_id::text=any(ids) and entity in ('campaign','campaigns'))
    or to_jsonb(system_events)->'meta'->>'campaign_id'=any(ids);
  delete from campaigns where id::text=any(ids);
  return found_count;
end $$;

revoke all on function campaign_delete_preview(text,text), delete_campaigns_with_data(text[],text) from public,anon,authenticated;
grant execute on function campaign_delete_preview(text,text), delete_campaigns_with_data(text[],text) to service_role;
commit;
