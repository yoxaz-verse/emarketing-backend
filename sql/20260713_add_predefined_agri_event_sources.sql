ALTER TABLE public.event_sources
  DROP CONSTRAINT IF EXISTS event_sources_provider_type_check;

ALTER TABLE public.event_sources
  ADD CONSTRAINT event_sources_provider_type_check
  CHECK (provider_type IN ('rss', 'ics', 'api', 'html'));

ALTER TABLE public.event_sources
  ADD COLUMN IF NOT EXISTS parser_key text NULL;

INSERT INTO public.event_sources (
  source_name,
  provider_type,
  source_url,
  parser_key,
  geography_scope,
  country,
  state,
  district,
  categories,
  trust_score,
  polling_interval_minutes,
  active
)
SELECT *
FROM (
  VALUES
    (
      'TPCI Forthcoming Events',
      'html',
      'https://www.tpci.in/forthcoming-events/',
      'tpci_forthcoming_events',
      'international',
      NULL,
      NULL,
      NULL,
      ARRAY['food export', 'agri', 'buyer seller meet', 'trade fair', 'import export'],
      0.90::numeric,
      360,
      true
    ),
    (
      'APEDA Events & Trade Fairs',
      'html',
      'https://apeda.gov.in/TradeFairs',
      'apeda_trade_fairs',
      'international',
      'India',
      NULL,
      NULL,
      ARRAY['food export', 'agri', 'rice', 'processed food', 'cashew', 'groundnut', 'trade fair'],
      0.95::numeric,
      720,
      true
    ),
    (
      'Spices Board Trade Fairs',
      'html',
      'https://www.indianspices.com/marketing/trade/trade-fairs.html',
      'spices_board_trade_fairs',
      'international',
      'India',
      NULL,
      NULL,
      ARRAY['spices', 'food export', 'agri', 'trade fair', 'import export'],
      0.95::numeric,
      720,
      true
    ),
    (
      'Kerala Startup Mission Events',
      'html',
      'https://startupmission.kerala.gov.in/events',
      'ksum_events',
      'kerala',
      'India',
      'Kerala',
      NULL,
      ARRAY['agri', 'foodtech', 'startup', 'kerala', 'trade fair'],
      0.85::numeric,
      360,
      true
    ),
    (
      'ITPO Food & Trade Fair Updates',
      'html',
      'https://www.itpo.gov.in/',
      'itpo_aahar_events',
      'india',
      'India',
      NULL,
      NULL,
      ARRAY['food export', 'trade fair', 'aahar', 'hospitality', 'import export'],
      0.85::numeric,
      720,
      true
    ),
    (
      'Cashew Export Promotion Council Updates',
      'html',
      'https://www.cashewindia.org/',
      'cepci_events',
      'international',
      'India',
      NULL,
      NULL,
      ARRAY['cashew', 'dry fruits', 'food export', 'agri', 'trade fair'],
      0.85::numeric,
      720,
      true
    ),
    (
      'Indian Pulses and Grains Association Events',
      'html',
      'https://ipga.co.in/',
      'ipga_events',
      'india',
      'India',
      NULL,
      NULL,
      ARRAY['pulses', 'grains', 'rice', 'agri', 'food export', 'trade fair'],
      0.85::numeric,
      720,
      true
    )
) AS seed(
  source_name,
  provider_type,
  source_url,
  parser_key,
  geography_scope,
  country,
  state,
  district,
  categories,
  trust_score,
  polling_interval_minutes,
  active
)
WHERE NOT EXISTS (
  SELECT 1
  FROM public.event_sources existing
  WHERE lower(existing.source_url) = lower(seed.source_url)
);
