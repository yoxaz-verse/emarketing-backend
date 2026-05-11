create table if not exists public.marketplace_connectors (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  marketplace_status text not null check (marketplace_status in ('public_api', 'partner_api', 'no_api_manual')),
  auth_type text not null check (auth_type in ('none', 'api_key', 'oauth2', 'partner')),
  can_create_draft boolean not null default false,
  can_publish boolean not null default false,
  can_update_price boolean not null default false,
  can_update_inventory boolean not null default false,
  supports_webhook boolean not null default false,
  credentials_active boolean not null default false,
  deep_link_url text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.marketplace_publish_requests (
  id uuid primary key default gen_random_uuid(),
  idempotency_key text not null unique,
  listing_input jsonb not null,
  targets text[] not null,
  operator_id text,
  created_by text,
  created_at timestamptz not null default now()
);

create table if not exists public.marketplace_publish_jobs (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.marketplace_publish_requests(id) on delete cascade,
  marketplace_code text not null references public.marketplace_connectors(code),
  status text not null,
  phase text not null,
  listing_input jsonb not null,
  validation_errors jsonb,
  external_listing_id text,
  external_listing_url text,
  manual_task jsonb,
  partner_onboarding jsonb,
  error_code text,
  error_message text,
  timeline jsonb not null default '[]'::jsonb,
  attempts integer not null default 0,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_marketplace_publish_jobs_request_id on public.marketplace_publish_jobs(request_id);
create index if not exists idx_marketplace_publish_jobs_status on public.marketplace_publish_jobs(status);

insert into public.marketplace_connectors (
  code, name, marketplace_status, auth_type,
  can_create_draft, can_publish, can_update_price, can_update_inventory,
  supports_webhook, credentials_active, deep_link_url, metadata
) values
  ('alibaba', 'Alibaba', 'partner_api', 'partner', true, true, true, true, false, false, 'https://seller.alibaba.com/', '{"region":"global"}'::jsonb),
  ('global_sources', 'Global Sources', 'partner_api', 'partner', true, true, false, false, false, false, 'https://www.globalsources.com/', '{"region":"global"}'::jsonb),
  ('tradekey', 'TradeKey', 'no_api_manual', 'none', false, false, false, false, false, false, 'https://www.tradekey.com/', '{"region":"global"}'::jsonb),
  ('ec21', 'EC21', 'public_api', 'api_key', true, true, true, true, true, false, 'https://www.ec21.com/', '{"region":"global"}'::jsonb),
  ('go4worldbusiness', 'Go4WorldBusiness', 'no_api_manual', 'none', false, false, false, false, false, false, 'https://www.go4worldbusiness.com/', '{"region":"global"}'::jsonb)
on conflict (code) do update set
  name = excluded.name,
  marketplace_status = excluded.marketplace_status,
  auth_type = excluded.auth_type,
  can_create_draft = excluded.can_create_draft,
  can_publish = excluded.can_publish,
  can_update_price = excluded.can_update_price,
  can_update_inventory = excluded.can_update_inventory,
  supports_webhook = excluded.supports_webhook,
  deep_link_url = excluded.deep_link_url,
  metadata = excluded.metadata,
  updated_at = now();
