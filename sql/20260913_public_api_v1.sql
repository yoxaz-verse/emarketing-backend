-- Apply before deploying the API portal. Existing legacy keys remain valid on legacy routes.
alter table public.api_keys add column if not exists name text;
alter table public.api_keys add column if not exists key_prefix text;
alter table public.api_keys add column if not exists scopes text[];
alter table public.api_keys add column if not exists expires_at timestamptz;
alter table public.api_keys add column if not exists revoked_at timestamptz;
alter table public.api_keys add column if not exists created_by uuid;
alter table public.api_keys add column if not exists revoked_by uuid;
alter table public.api_keys add column if not exists rotated_from uuid;
create index if not exists api_keys_key_prefix_idx on public.api_keys(key_prefix);
create index if not exists api_keys_user_id_idx on public.api_keys(user_id);
alter table public.api_keys enable row level security;

create table if not exists public.api_idempotency (
  id uuid primary key default gen_random_uuid(),
  api_key_id uuid not null references public.api_keys(id) on delete cascade,
  request_key text not null,
  request_hash text not null,
  status text not null default 'pending' check (status in ('pending', 'complete')),
  http_status integer,
  response jsonb,
  created_at timestamptz not null default now(),
  unique(api_key_id, request_key)
);
create index if not exists api_idempotency_created_at_idx on public.api_idempotency(created_at);

-- Service-role access only: public clients must never read token hashes or replay records.
alter table public.api_idempotency enable row level security;
