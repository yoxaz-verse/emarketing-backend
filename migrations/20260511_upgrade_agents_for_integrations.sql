create table if not exists public.agents (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  provider text not null default 'custom',
  endpoint text,
  headers_config jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.agents
  add column if not exists provider_type text not null default 'custom',
  add column if not exists base_url text,
  add column if not exists auth_type text not null default 'none',
  add column if not exists auth_header_name text,
  add column if not exists auth_secret_encrypted text,
  add column if not exists default_model text,
  add column if not exists default_path text,
  add column if not exists status text not null default 'unknown',
  add column if not exists last_test_at timestamptz,
  add column if not exists last_test_status text,
  add column if not exists last_test_message text,
  add column if not exists last_test_latency_ms integer;

create index if not exists idx_agents_provider on public.agents(provider);
create index if not exists idx_agents_status on public.agents(status);
