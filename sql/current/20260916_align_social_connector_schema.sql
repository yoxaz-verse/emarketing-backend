begin;

-- Facebook and Instagram use separate scheduler targets while sharing the
-- existing Meta OAuth application and authorization row.
alter table public.social_connectors
  drop constraint if exists social_connectors_code_check;

alter table public.social_connectors
  add constraint social_connectors_code_check
  check (code in (
    'meta',
    'facebook',
    'instagram',
    'linkedin',
    'reddit',
    'telegram',
    'whatsapp'
  ));

alter table public.social_oauth_states
  add column if not exists requested_platform text;

comment on column public.social_oauth_states.requested_platform is
  'Original connector selected by the user; Facebook and Instagram share platform_code=meta.';

insert into public.social_connectors
  (code, name, status, auth_type, can_schedule, can_publish, credentials_active, deep_link_url, metadata)
values
  ('facebook', 'Facebook', 'manual_assisted', 'oauth2', true, true, false, 'https://business.facebook.com/', '{}'::jsonb),
  ('instagram', 'Instagram', 'manual_assisted', 'oauth2', true, true, false, 'https://www.instagram.com/', '{}'::jsonb)
on conflict (code) do update set
  name = excluded.name,
  can_schedule = true,
  can_publish = true,
  deep_link_url = excluded.deep_link_url,
  updated_at = now();

-- The notification is delivered when this transaction commits.
notify pgrst, 'reload schema';

commit;

-- Verification results should show one constraint, the requested_platform
-- column, all seven connectors, and the due-job index.
select pg_get_constraintdef(oid) as social_connectors_code_check
from pg_constraint
where conrelid = 'public.social_connectors'::regclass
  and conname = 'social_connectors_code_check';

select column_name, data_type, is_nullable
from information_schema.columns
where table_schema = 'public'
  and table_name = 'social_oauth_states'
  and column_name = 'requested_platform';

select code, name, status, auth_type, can_schedule, can_publish
from public.social_connectors
where code in ('meta', 'facebook', 'instagram', 'linkedin', 'reddit', 'telegram', 'whatsapp')
order by code;

select indexname, indexdef
from pg_indexes
where schemaname = 'public'
  and tablename = 'social_publish_jobs'
  and indexname = 'social_publish_jobs_due_idx';
