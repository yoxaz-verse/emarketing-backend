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
  state text not null,
  platform_code text not null,
  user_id uuid not null,
  operator_id uuid not null,
  metadata jsonb not null default '{}'::jsonb,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
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
alter table public.social_oauth_states add column if not exists state text;
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

alter table public.social_oauth_connections
  drop constraint if exists social_oauth_connections_status_check;

alter table public.social_oauth_connections
  add constraint social_oauth_connections_status_check
  check (status in ('connected', 'disconnected', 'expired', 'missing_scope', 'error'));

create unique index if not exists social_global_oauth_apps_platform_uidx
  on public.social_global_oauth_apps (platform_code);

create unique index if not exists social_operator_oauth_apps_operator_platform_uidx
  on public.social_operator_oauth_apps (operator_id, platform_code);

create unique index if not exists social_oauth_states_state_uidx
  on public.social_oauth_states (state);

create index if not exists social_oauth_states_operator_platform_idx
  on public.social_oauth_states (operator_id, platform_code);

create unique index if not exists social_oauth_connections_platform_user_operator_uidx
  on public.social_oauth_connections (platform_code, user_id, operator_id);

create index if not exists social_oauth_connections_operator_platform_idx
  on public.social_oauth_connections (operator_id, platform_code);
