create table if not exists public.social_global_oauth_apps (
  platform_code text primary key,
  client_id text,
  client_secret_encrypted text not null,
  redirect_uri text,
  scopes text[] default '{}'::text[],
  metadata jsonb default '{}'::jsonb,
  active boolean not null default true,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists social_global_oauth_apps_active_idx
  on public.social_global_oauth_apps (active, platform_code);
