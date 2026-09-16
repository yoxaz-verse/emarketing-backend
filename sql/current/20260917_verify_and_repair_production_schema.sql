begin;

-- Required when an existing scheduled request is edited.
alter table public.social_publish_requests
  add column if not exists updated_at timestamptz not null default now();

-- Fail with a precise message rather than silently discarding production data
-- if an earlier installation contains duplicate idempotency keys.
do $$
begin
  if exists (
    select 1
    from public.communication_messages
    where idempotency_key is not null
    group by user_id, idempotency_key
    having count(*) > 1
  ) then
    raise exception 'Cannot create communication idempotency index: duplicate (user_id, idempotency_key) rows exist';
  end if;

  if exists (
    select 1
    from public.api_idempotency
    group by api_key_id, request_key
    having count(*) > 1
  ) then
    raise exception 'Cannot create API idempotency index: duplicate (api_key_id, request_key) rows exist';
  end if;
end $$;

create index if not exists social_publish_jobs_due_idx
  on public.social_publish_jobs (scheduled_at, status)
  where status = 'scheduled';

create unique index if not exists social_oauth_states_state_hash_uidx
  on public.social_oauth_states (state_hash);

create unique index if not exists social_oauth_connections_platform_user_operator_uidx
  on public.social_oauth_connections (platform_code, user_id, operator_id);

create unique index if not exists communication_queue_dedupe
  on public.communication_queue (source_table, source_id, md5(payload::text));

create index if not exists communication_items_order
  on public.communication_items (occurred_at desc, id desc);

create index if not exists communication_messages_thread
  on public.communication_messages (conversation_id, occurred_at, id);

create index if not exists communication_messages_mid
  on public.communication_messages (message_id);

create unique index if not exists communication_messages_user_id_idempotency_key_uidx
  on public.communication_messages (user_id, idempotency_key);

create unique index if not exists api_idempotency_api_key_request_key_uidx
  on public.api_idempotency (api_key_id, request_key);

create index if not exists api_idempotency_created_at_idx
  on public.api_idempotency (created_at);

-- Keep the shared Meta authorization target alongside the separate publishing
-- destinations. Existing connector state is never overwritten.
insert into public.social_connectors
  (code, name, status, auth_type, can_schedule, can_publish, credentials_active, deep_link_url, metadata)
values
  ('meta', 'Meta', 'manual_assisted', 'oauth2', true, true, false, 'https://business.facebook.com/', '{}'::jsonb),
  ('facebook', 'Facebook', 'manual_assisted', 'oauth2', true, true, false, 'https://business.facebook.com/', '{}'::jsonb),
  ('instagram', 'Instagram', 'manual_assisted', 'oauth2', true, true, false, 'https://www.instagram.com/', '{}'::jsonb)
on conflict (code) do nothing;

notify pgrst, 'reload schema';

commit;

-- A healthy result returns zero rows. Any returned row names an object that
-- still needs investigation before deploying the application.
with required_objects(object_kind, object_name, present) as (
  values
    ('column', 'social_publish_requests.updated_at', exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'social_publish_requests' and column_name = 'updated_at'
    )),
    ('index', 'social_publish_jobs_due_idx', to_regclass('public.social_publish_jobs_due_idx') is not null),
    ('index', 'social_oauth_states_state_hash_uidx', to_regclass('public.social_oauth_states_state_hash_uidx') is not null),
    ('index', 'social_oauth_connections_platform_user_operator_uidx', to_regclass('public.social_oauth_connections_platform_user_operator_uidx') is not null),
    ('index', 'communication_queue_dedupe', to_regclass('public.communication_queue_dedupe') is not null),
    ('index', 'communication_items_order', to_regclass('public.communication_items_order') is not null),
    ('index', 'communication_messages_thread', to_regclass('public.communication_messages_thread') is not null),
    ('index', 'communication_messages_mid', to_regclass('public.communication_messages_mid') is not null),
    ('index', 'communication_messages_user_id_idempotency_key_uidx', to_regclass('public.communication_messages_user_id_idempotency_key_uidx') is not null),
    ('index', 'api_idempotency_api_key_request_key_uidx', to_regclass('public.api_idempotency_api_key_request_key_uidx') is not null),
    ('index', 'api_idempotency_created_at_idx', to_regclass('public.api_idempotency_created_at_idx') is not null),
    ('function', 'communication_lease(text,boolean)', to_regprocedure('public.communication_lease(text,boolean)') is not null),
    ('function', 'communication_append(jsonb,jsonb,jsonb,boolean)', to_regprocedure('public.communication_append(jsonb,jsonb,jsonb,boolean)') is not null),
    ('function', 'communication_finish_send(uuid,text)', to_regprocedure('public.communication_finish_send(uuid,text)') is not null),
    ('function', 'communication_list(text,text,text,text,boolean,integer,integer,uuid)', to_regprocedure('public.communication_list(text,text,text,text,boolean,integer,integer,uuid)') is not null),
    ('function', 'communication_mark_read(text,uuid[],timestamptz)', to_regprocedure('public.communication_mark_read(text,uuid[],timestamptz)') is not null),
    ('function', 'campaign_delete_preview(text,text)', to_regprocedure('public.campaign_delete_preview(text,text)') is not null),
    ('function', 'delete_campaigns_with_data(text[],text)', to_regprocedure('public.delete_campaigns_with_data(text[],text)') is not null),
    ('connector', 'meta', exists (select 1 from public.social_connectors where code = 'meta')),
    ('connector', 'facebook', exists (select 1 from public.social_connectors where code = 'facebook')),
    ('connector', 'instagram', exists (select 1 from public.social_connectors where code = 'instagram'))
)
select object_kind, object_name, 'missing' as status
from required_objects
where not present
order by object_kind, object_name;

select
  (select updated_at from public.social_publish_requests order by created_at desc limit 1) as latest_social_request_updated_at,
  (select count(*) from public.social_connectors where code in ('meta', 'facebook', 'instagram')) as required_connector_count,
  'production schema verification complete' as result;
