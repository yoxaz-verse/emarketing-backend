create extension if not exists pgcrypto;

create table if not exists public.event_sources (
  id uuid primary key default gen_random_uuid(),
  source_name text not null,
  provider_type text not null,
  source_url text not null,
  geography_scope text not null default 'international',
  country text,
  state text,
  district text,
  categories text[] not null default '{}',
  parser_key text,
  trust_score numeric not null default 0.7,
  polling_interval_minutes integer not null default 360,
  active boolean not null default true,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.event_sources ADD COLUMN IF NOT EXISTS parser_key text;
alter table public.event_sources ADD COLUMN IF NOT EXISTS categories text[] not null default '{}';
alter table public.event_sources ADD COLUMN IF NOT EXISTS trust_score numeric not null default 0.7;
alter table public.event_sources ADD COLUMN IF NOT EXISTS polling_interval_minutes integer not null default 360;
alter table public.event_sources ADD COLUMN IF NOT EXISTS active boolean not null default true;
alter table public.event_sources ADD COLUMN IF NOT EXISTS updated_at timestamptz not null default now();

create unique index if not exists event_sources_source_url_uidx
  on public.event_sources (source_url);

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
    ('Startup India Challenges', 'html', 'https://www.startupindia.gov.in/content/sih/en/government-schemes.html', 'india', 'India', null, array['startup', 'agritech', 'innovation'], 'startup_india_challenges', 0.82, 720),
    ('IndiaAI Events', 'html', 'https://indiaai.gov.in/events', 'india', 'India', null, array['ai', 'agritech', 'technology'], 'indiaai_events', 0.8, 720),
    ('Karnataka Startup Events', 'html', 'https://startup.karnataka.gov.in/events/', 'india', 'India', 'Karnataka', array['startup', 'ai', 'agritech'], 'karnataka_startup_events', 0.78, 720),
    ('CII AgriTech Events', 'html', 'https://www.cii.in/agritech-events.aspx', 'india', 'India', null, array['agritech', 'startup', 'ai'], 'cii_events', 0.8, 720),
    ('Agri Trade Intelligence Events', 'html', 'https://agriexchange.apeda.gov.in/TradeEvents.aspx', 'india', 'India', null, array['agritech', 'export', 'startup'], 'agri_trade_events', 0.8, 720),
    ('Kerala Startup Mission Events', 'html', 'https://startupmission.kerala.gov.in/events', 'india', 'India', 'Kerala', array['startup', 'ai', 'agritech'], 'ksum_events', 0.78, 720),
    ('NASSCOM AI Events', 'html', 'https://nasscom.in/events', 'india', 'India', null, array['ai', 'startup', 'technology'], 'generic_html_events', 0.76, 720)
) as v(source_name, provider_type, source_url, geography_scope, country, state, categories, parser_key, trust_score, polling_interval_minutes)
WHERE NOT EXISTS (
  select 1
  from public.event_sources existing
  where existing.source_url = v.source_url
);
