create table if not exists public.social_operator_oauth_apps (
  id uuid primary key default gen_random_uuid(),
  operator_id uuid not null references public.operators(id) on delete cascade,
  platform_code text not null check (platform_code = any (array['linkedin'::text, 'meta'::text, 'reddit'::text, 'telegram'::text, 'whatsapp'::text])),
  client_id text,
  client_secret_encrypted text not null,
  redirect_uri text,
  scopes text[] not null default '{}'::text[],
  metadata jsonb not null default '{}'::jsonb,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (operator_id, platform_code)
);

create index if not exists social_operator_oauth_apps_active_idx
  on public.social_operator_oauth_apps (active, platform_code, operator_id);

create table if not exists public.social_oauth_states (
  id uuid primary key default gen_random_uuid(),
  state_hash text not null unique,
  platform_code text not null check (platform_code = any (array['linkedin'::text, 'meta'::text, 'reddit'::text, 'telegram'::text, 'whatsapp'::text])),
  user_id uuid not null references public.users(id) on delete cascade,
  operator_id uuid not null references public.operators(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists social_oauth_states_platform_expiry_idx
  on public.social_oauth_states (platform_code, expires_at);

create table if not exists public.social_oauth_connections (
  id uuid primary key default gen_random_uuid(),
  platform_code text not null check (platform_code = any (array['linkedin'::text, 'meta'::text, 'reddit'::text, 'telegram'::text, 'whatsapp'::text])),
  user_id uuid not null references public.users(id) on delete cascade,
  operator_id uuid not null references public.operators(id) on delete cascade,
  access_token_encrypted text not null,
  refresh_token_encrypted text,
  expires_at timestamptz,
  scopes text[] not null default '{}'::text[],
  metadata jsonb not null default '{}'::jsonb,
  status text not null default 'connected'::text,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (platform_code, user_id, operator_id)
);

create index if not exists social_oauth_connections_operator_platform_idx
  on public.social_oauth_connections (operator_id, platform_code);

