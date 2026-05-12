create table if not exists public.social_oauth_states (
  id uuid primary key default gen_random_uuid(),
  state_hash text not null unique,
  platform_code text not null check (platform_code in ('linkedin')),
  user_id text not null,
  operator_id text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_social_oauth_states_platform on public.social_oauth_states(platform_code);
create index if not exists idx_social_oauth_states_expiry on public.social_oauth_states(expires_at);

create table if not exists public.social_oauth_connections (
  id uuid primary key default gen_random_uuid(),
  platform_code text not null check (platform_code in ('linkedin')),
  user_id text not null,
  operator_id text not null,
  access_token_encrypted text not null,
  refresh_token_encrypted text,
  expires_at timestamptz,
  scopes text[] not null default '{}'::text[],
  metadata jsonb not null default '{}'::jsonb,
  status text not null default 'connected' check (status in ('connected','expired','missing_scope','disconnected')),
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (platform_code, user_id, operator_id)
);

create index if not exists idx_social_oauth_connections_platform on public.social_oauth_connections(platform_code);
create index if not exists idx_social_oauth_connections_user_operator on public.social_oauth_connections(user_id, operator_id);

alter table public.social_connectors
  drop constraint if exists social_connectors_status_check;
alter table public.social_connectors
  add constraint social_connectors_status_check check (status in ('manual_assisted', 'api_enabled'));

alter table public.social_connectors
  drop constraint if exists social_connectors_auth_type_check;
alter table public.social_connectors
  add constraint social_connectors_auth_type_check check (auth_type in ('none', 'oauth2'));

update public.social_connectors
set
  auth_type = case when code = 'linkedin' then 'oauth2' else auth_type end,
  status = case when code = 'linkedin' then 'manual_assisted' else status end,
  metadata = coalesce(metadata, '{}'::jsonb) || case when code = 'linkedin' then '{"capabilities":["text_link"]}'::jsonb else '{}'::jsonb end,
  updated_at = now()
where code in ('linkedin','meta','reddit','telegram','whatsapp');

alter table public.social_publish_jobs
  add column if not exists provider_error_code text;
alter table public.social_publish_jobs
  add column if not exists provider_error_message text;
