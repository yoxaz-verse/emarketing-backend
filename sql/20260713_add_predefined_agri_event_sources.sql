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

alter table public.event_sources
  drop constraint if exists event_sources_provider_type_check;

alter table public.event_sources
  add constraint event_sources_provider_type_check
  check (provider_type IN ('rss', 'ics', 'api', 'html'));

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
    ('APEDA Trade Fairs', 'html', 'https://apeda.gov.in/apedawebsite/trade_promotion/trade_fairs.htm', 'india', 'India', null, array['agri', 'export', 'trade fair'], 'apeda_trade_fairs', 0.86, 720),
    ('Spices Board Trade Fairs', 'html', 'https://www.indianspices.com/trade/trade-fairs.html', 'india', 'India', null, array['spices', 'agri', 'export'], 'spices_board_trade_fairs', 0.84, 720),
    ('TPCI Forthcoming Events', 'html', 'https://www.tpci.in/indiabusinesstrade/forthcoming-events/', 'india', 'India', null, array['trade', 'export', 'agri'], 'tpci_forthcoming_events', 0.82, 720),
    ('CII Food and Agriculture Events', 'html', 'https://www.cii.in/Events.aspx', 'india', 'India', null, array['agri', 'food processing', 'industry'], 'cii_events', 0.8, 720),
    ('ITPO AAHAR Events', 'html', 'https://indiatradefair.com/aahardelhi/', 'india', 'India', 'Delhi', array['food export', 'trade fair', 'agri'], 'itpo_aahar_events', 0.8, 720),
    ('CEPCI Events', 'html', 'https://www.cepc.co.in/events', 'india', 'India', 'Kerala', array['cashew', 'export', 'agri'], 'cepci_events', 0.78, 720),
    ('IPGA Events', 'html', 'https://ipga.co.in/events/', 'india', 'India', null, array['pulses', 'agri', 'trade'], 'ipga_events', 0.78, 720)
) as v(source_name, provider_type, source_url, geography_scope, country, state, categories, parser_key, trust_score, polling_interval_minutes)
WHERE NOT EXISTS (
  select 1
  from public.event_sources existing
  where existing.source_url = v.source_url
);
