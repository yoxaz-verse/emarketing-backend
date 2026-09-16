create extension if not exists pgcrypto;

create table if not exists public.social_global_oauth_apps (
  id uuid primary key default gen_random_uuid(),
  platform_code text not null,
  client_id text,
  client_secret_encrypted text,
  redirect_uri text,
  scopes text[] not null default '{}',
  metadata jsonb not null default '{}'::jsonb,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.social_operator_oauth_apps (
  id uuid primary key default gen_random_uuid(),
  operator_id uuid not null,
  platform_code text not null,
  client_id text,
  client_secret_encrypted text,
  redirect_uri text,
  scopes text[] not null default '{}',
  metadata jsonb not null default '{}'::jsonb,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.social_oauth_states (
  id uuid primary key default gen_random_uuid(),
  state_hash text not null,
  platform_code text not null,
  user_id uuid not null,
  operator_id uuid not null,
  metadata jsonb not null default '{}'::jsonb,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.social_connectors (
  code text primary key,
  name text not null,
  status text not null default 'manual_assisted',
  auth_type text not null default 'none',
  can_schedule boolean not null default true,
  can_publish boolean not null default true,
  credentials_active boolean not null default false,
  deep_link_url text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.social_publish_requests (
  id uuid primary key default gen_random_uuid(),
  idempotency_key text not null,
  targets text[] not null default '{}',
  post_input jsonb not null default '{}'::jsonb,
  operator_id uuid,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.social_publish_jobs (
  id uuid primary key default gen_random_uuid(),
  request_id uuid references public.social_publish_requests(id) on delete cascade,
  platform_code text not null references public.social_connectors(code),
  status text not null default 'draft_created',
  phase text not null default 'DRAFT_CREATE',
  post_input jsonb not null default '{}'::jsonb,
  scheduled_at timestamptz,
  manual_task jsonb,
  external_post_id text,
  external_post_url text,
  validation_errors text[],
  error_code text,
  error_message text,
  provider_error_code text,
  provider_error_message text,
  timeline jsonb not null default '[]'::jsonb,
  attempts integer not null default 0,
  operator_id uuid,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.social_oauth_connections (
  id uuid primary key default gen_random_uuid(),
  platform_code text not null,
  user_id uuid not null,
  operator_id uuid not null,
  access_token_encrypted text,
  refresh_token_encrypted text,
  expires_at timestamptz,
  scopes text[] not null default '{}',
  status text not null default 'connected',
  metadata jsonb not null default '{}'::jsonb,
  last_error text,
  connected_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.social_global_oauth_apps add column if not exists id uuid default gen_random_uuid();
alter table public.social_global_oauth_apps add column if not exists platform_code text;
alter table public.social_global_oauth_apps add column if not exists client_id text;
alter table public.social_global_oauth_apps add column if not exists client_secret_encrypted text;
alter table public.social_global_oauth_apps add column if not exists redirect_uri text;
alter table public.social_global_oauth_apps add column if not exists scopes text[] not null default '{}';
alter table public.social_global_oauth_apps add column if not exists metadata jsonb not null default '{}'::jsonb;
alter table public.social_global_oauth_apps add column if not exists active boolean not null default true;
alter table public.social_global_oauth_apps add column if not exists created_at timestamptz not null default now();
alter table public.social_global_oauth_apps add column if not exists updated_at timestamptz not null default now();

alter table public.social_operator_oauth_apps add column if not exists id uuid default gen_random_uuid();
alter table public.social_operator_oauth_apps add column if not exists operator_id uuid;
alter table public.social_operator_oauth_apps add column if not exists platform_code text;
alter table public.social_operator_oauth_apps add column if not exists client_id text;
alter table public.social_operator_oauth_apps add column if not exists client_secret_encrypted text;
alter table public.social_operator_oauth_apps add column if not exists redirect_uri text;
alter table public.social_operator_oauth_apps add column if not exists scopes text[] not null default '{}';
alter table public.social_operator_oauth_apps add column if not exists metadata jsonb not null default '{}'::jsonb;
alter table public.social_operator_oauth_apps add column if not exists active boolean not null default true;
alter table public.social_operator_oauth_apps add column if not exists created_at timestamptz not null default now();
alter table public.social_operator_oauth_apps add column if not exists updated_at timestamptz not null default now();

alter table public.social_oauth_states add column if not exists id uuid default gen_random_uuid();
alter table public.social_oauth_states add column if not exists state_hash text;
alter table public.social_oauth_states add column if not exists platform_code text;
alter table public.social_oauth_states add column if not exists user_id uuid;
alter table public.social_oauth_states add column if not exists operator_id uuid;
alter table public.social_oauth_states add column if not exists metadata jsonb not null default '{}'::jsonb;
alter table public.social_oauth_states add column if not exists expires_at timestamptz not null default now();
alter table public.social_oauth_states add column if not exists consumed_at timestamptz;
alter table public.social_oauth_states add column if not exists created_at timestamptz not null default now();

alter table public.social_oauth_connections add column if not exists id uuid default gen_random_uuid();
alter table public.social_oauth_connections add column if not exists platform_code text;
alter table public.social_oauth_connections add column if not exists user_id uuid;
alter table public.social_oauth_connections add column if not exists operator_id uuid;
alter table public.social_oauth_connections add column if not exists access_token_encrypted text;
alter table public.social_oauth_connections add column if not exists refresh_token_encrypted text;
alter table public.social_oauth_connections add column if not exists expires_at timestamptz;
alter table public.social_oauth_connections add column if not exists scopes text[] not null default '{}';
alter table public.social_oauth_connections add column if not exists status text not null default 'connected';
alter table public.social_oauth_connections add column if not exists metadata jsonb not null default '{}'::jsonb;
alter table public.social_oauth_connections add column if not exists last_error text;
alter table public.social_oauth_connections add column if not exists connected_at timestamptz;
alter table public.social_oauth_connections add column if not exists created_at timestamptz not null default now();
alter table public.social_oauth_connections add column if not exists updated_at timestamptz not null default now();

alter table public.social_connectors add column if not exists code text;
alter table public.social_connectors add column if not exists name text;
alter table public.social_connectors add column if not exists status text not null default 'manual_assisted';
alter table public.social_connectors add column if not exists auth_type text not null default 'none';
alter table public.social_connectors add column if not exists can_schedule boolean not null default true;
alter table public.social_connectors add column if not exists can_publish boolean not null default true;
alter table public.social_connectors add column if not exists credentials_active boolean not null default false;
alter table public.social_connectors add column if not exists deep_link_url text;
alter table public.social_connectors add column if not exists metadata jsonb not null default '{}'::jsonb;
alter table public.social_connectors add column if not exists created_at timestamptz not null default now();
alter table public.social_connectors add column if not exists updated_at timestamptz not null default now();

alter table public.social_publish_requests add column if not exists id uuid default gen_random_uuid();
alter table public.social_publish_requests add column if not exists idempotency_key text;
alter table public.social_publish_requests add column if not exists targets text[] not null default '{}';
alter table public.social_publish_requests add column if not exists post_input jsonb not null default '{}'::jsonb;
alter table public.social_publish_requests add column if not exists operator_id uuid;
alter table public.social_publish_requests add column if not exists created_by uuid;
alter table public.social_publish_requests add column if not exists created_at timestamptz not null default now();
alter table public.social_publish_requests add column if not exists updated_at timestamptz not null default now();

alter table public.social_publish_jobs add column if not exists id uuid default gen_random_uuid();
alter table public.social_publish_jobs add column if not exists request_id uuid;
alter table public.social_publish_jobs add column if not exists platform_code text;
alter table public.social_publish_jobs add column if not exists status text not null default 'draft_created';
alter table public.social_publish_jobs add column if not exists phase text not null default 'DRAFT_CREATE';
alter table public.social_publish_jobs add column if not exists post_input jsonb not null default '{}'::jsonb;
alter table public.social_publish_jobs add column if not exists scheduled_at timestamptz;
alter table public.social_publish_jobs add column if not exists manual_task jsonb;
alter table public.social_publish_jobs add column if not exists external_post_id text;
alter table public.social_publish_jobs add column if not exists external_post_url text;
alter table public.social_publish_jobs add column if not exists validation_errors text[];
alter table public.social_publish_jobs add column if not exists error_code text;
alter table public.social_publish_jobs add column if not exists error_message text;
alter table public.social_publish_jobs add column if not exists provider_error_code text;
alter table public.social_publish_jobs add column if not exists provider_error_message text;
alter table public.social_publish_jobs add column if not exists timeline jsonb not null default '[]'::jsonb;
alter table public.social_publish_jobs add column if not exists attempts integer not null default 0;
alter table public.social_publish_jobs add column if not exists operator_id uuid;
alter table public.social_publish_jobs add column if not exists created_by uuid;
alter table public.social_publish_jobs add column if not exists created_at timestamptz not null default now();
alter table public.social_publish_jobs add column if not exists updated_at timestamptz not null default now();

alter table public.social_oauth_connections
  drop constraint if exists social_oauth_connections_status_check;

alter table public.social_oauth_connections
  add constraint social_oauth_connections_status_check
  check (status in ('connected', 'disconnected', 'expired', 'missing_scope', 'error'));

create unique index if not exists social_global_oauth_apps_platform_uidx
  on public.social_global_oauth_apps (platform_code);

create unique index if not exists social_operator_oauth_apps_operator_platform_uidx
  on public.social_operator_oauth_apps (operator_id, platform_code);

drop index if exists social_oauth_states_state_uidx;

create unique index if not exists social_oauth_states_state_hash_uidx
  on public.social_oauth_states (state_hash);

create index if not exists social_oauth_states_operator_platform_idx
  on public.social_oauth_states (operator_id, platform_code);

create unique index if not exists social_oauth_connections_platform_user_operator_uidx
  on public.social_oauth_connections (platform_code, user_id, operator_id);

create index if not exists social_oauth_connections_operator_platform_idx
  on public.social_oauth_connections (operator_id, platform_code);

create unique index if not exists social_publish_requests_idempotency_uidx
  on public.social_publish_requests (idempotency_key);

create index if not exists social_publish_jobs_request_idx
  on public.social_publish_jobs (request_id);

create index if not exists social_publish_jobs_operator_status_idx
  on public.social_publish_jobs (operator_id, status, scheduled_at);

insert into public.social_connectors (code, name, status, auth_type, can_schedule, can_publish, credentials_active, deep_link_url, metadata)
values
  ('linkedin', 'LinkedIn', 'manual_assisted', 'none', true, true, false, 'https://www.linkedin.com/feed/', '{}'::jsonb),
  ('meta', 'Meta / Instagram', 'manual_assisted', 'none', true, true, false, 'https://business.facebook.com/latest/composer', '{}'::jsonb),
  ('reddit', 'Reddit', 'manual_assisted', 'none', true, true, false, 'https://www.reddit.com/submit', '{}'::jsonb),
  ('telegram', 'Telegram', 'manual_assisted', 'none', true, true, false, 'https://web.telegram.org/', '{}'::jsonb),
  ('whatsapp', 'WhatsApp', 'manual_assisted', 'none', true, true, false, 'https://web.whatsapp.com/', '{}'::jsonb)
on conflict (code) do update set
  name = excluded.name,
  can_schedule = excluded.can_schedule,
  can_publish = excluded.can_publish,
  deep_link_url = excluded.deep_link_url,
  updated_at = now();
