create extension if not exists pgcrypto;

alter table public.event_sources add column if not exists last_ingested_at timestamptz;
alter table public.event_sources add column if not exists last_checked_at timestamptz;
alter table public.event_sources add column if not exists last_success_at timestamptz;
alter table public.event_sources add column if not exists last_error text;
alter table public.event_sources add column if not exists health_status text not null default 'unknown';
alter table public.event_sources add column if not exists updated_by uuid;

alter table public.event_sources
  drop constraint if exists event_sources_health_status_check;

alter table public.event_sources
  add constraint event_sources_health_status_check
  check (health_status in ('unknown', 'healthy', 'error'));

create table if not exists public.event_items (
  id uuid primary key default gen_random_uuid(),
  source_id uuid references public.event_sources(id) on delete set null,
  title text not null,
  description text,
  starts_at timestamptz not null,
  ends_at timestamptz,
  timezone text,
  location text,
  geography_scope text not null default 'international',
  country text,
  state text,
  district text,
  category text,
  source_url text,
  source_snapshot jsonb not null default '{}'::jsonb,
  status text not null default 'discovered',
  planning_notes text,
  countdown_meta jsonb not null default '{}'::jsonb,
  dedupe_hash text not null,
  created_by uuid,
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.event_items
  drop constraint if exists event_items_status_check;

alter table public.event_items
  add constraint event_items_status_check
  check (status in ('discovered', 'planned', 'ignored', 'expired'));

alter table public.event_items
  drop constraint if exists event_items_scope_check;

alter table public.event_items
  add constraint event_items_scope_check
  check (geography_scope in ('international', 'india', 'kerala', 'district'));

create unique index if not exists event_items_dedupe_hash_uidx
  on public.event_items (dedupe_hash);

create index if not exists event_items_starts_at_idx
  on public.event_items (starts_at);

create index if not exists event_items_source_id_idx
  on public.event_items (source_id);

create index if not exists event_items_status_idx
  on public.event_items (status);

create table if not exists public.event_ingestion_runs (
  id uuid primary key default gen_random_uuid(),
  source_id uuid references public.event_sources(id) on delete set null,
  status text not null,
  processed_count integer not null default 0,
  inserted_count integer not null default 0,
  skipped_count integer not null default 0,
  error_count integer not null default 0,
  errors jsonb not null default '[]'::jsonb,
  metadata jsonb,
  started_at timestamptz,
  finished_at timestamptz,
  created_by uuid,
  created_at timestamptz not null default now()
);

alter table public.event_ingestion_runs
  drop constraint if exists event_ingestion_runs_status_check;

alter table public.event_ingestion_runs
  add constraint event_ingestion_runs_status_check
  check (status in ('success', 'partial', 'failed'));

create index if not exists event_ingestion_runs_source_id_idx
  on public.event_ingestion_runs (source_id);

create index if not exists event_ingestion_runs_created_at_idx
  on public.event_ingestion_runs (created_at desc);

update public.event_sources
set source_url = 'https://apeda.gov.in/TradeFairs',
    parser_key = 'apeda_trade_fairs',
    updated_at = now()
where source_url = 'https://apeda.gov.in/apedawebsite/trade_promotion/trade_fairs.htm';

insert into public.event_sources (
  source_name,
  provider_type,
  source_url,
  geography_scope,
  country,
  state,
  categories,
  parser_key,
  trust_score,
  polling_interval_minutes,
  active
)
select
  v.source_name,
  v.provider_type,
  v.source_url,
  v.geography_scope,
  v.country,
  v.state,
  v.categories,
  v.parser_key,
  v.trust_score,
  v.polling_interval_minutes,
  true
from (
  values
    ('APEDA Events and Trade Fairs', 'html', 'https://apeda.gov.in/TradeFairs', 'india', 'India', null, array['agri', 'export', 'trade fair'], 'apeda_trade_fairs', 0.9, 720),
    ('CII Trade Fairs', 'html', 'https://www.cii.in/TradeFairs.aspx', 'india', 'India', null, array['trade fair', 'agri', 'food processing', 'industry'], 'cii_trade_fairs', 0.82, 720),
    ('AIshala India AI Events', 'html', 'https://www.aishala.org/events', 'india', 'India', null, array['ai', 'startup', 'technology'], 'aishala_events', 0.76, 720),
    ('TradeFairDates Agriculture India', 'html', 'https://www.tradefairdates.com/Agriculture%20Trade%20Shows-India-FSL214-L103-S1.html', 'india', 'India', null, array['agri', 'trade fair', 'expo'], 'tradefairdates_agriculture_india', 0.72, 1440),
    ('CII AgroTech India Schedule', 'html', 'https://www.agrotech-india.com/Event_Schedule.php', 'india', 'India', null, array['agritech', 'food processing', 'trade fair'], 'agrotech_india_events', 0.8, 720)
) as v(source_name, provider_type, source_url, geography_scope, country, state, categories, parser_key, trust_score, polling_interval_minutes)
where not exists (
  select 1
  from public.event_sources existing
  where existing.source_url = v.source_url
);
