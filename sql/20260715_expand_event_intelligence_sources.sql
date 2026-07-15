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
      'Startup India Programs and Challenges',
      'html',
      'https://www.startupindia.gov.in/content/sih/en/ams-application/challenge.html',
      'startup_india_challenges',
      'india',
      'India',
      NULL,
      NULL,
      ARRAY['startup', 'challenge', 'market access', 'agritech', 'ai', 'india'],
      0.95::numeric,
      720,
      true
    ),
    (
      'IndiaAI Events',
      'html',
      'https://indiaai.gov.in/events',
      'indiaai_events',
      'india',
      'India',
      NULL,
      NULL,
      ARRAY['ai', 'startup', 'agritech', 'technology', 'india'],
      0.95::numeric,
      360,
      true
    ),
    (
      'India AI Impact Summit Resources',
      'html',
      'https://impact.indiaai.gov.in/',
      'indiaai_events',
      'india',
      'India',
      'Delhi',
      NULL,
      ARRAY['ai', 'startup', 'challenge', 'agritech', 'india'],
      0.95::numeric,
      720,
      true
    ),
    (
      'Karnataka Startup and Elevate Updates',
      'html',
      'https://startup.karnataka.gov.in/',
      'karnataka_startup_events',
      'india',
      'India',
      'Karnataka',
      NULL,
      ARRAY['startup', 'karnataka', 'agritech', 'ai', 'grant', 'challenge'],
      0.90::numeric,
      360,
      true
    ),
    (
      'CII Events',
      'html',
      'https://www.cii.in/Events.aspx',
      'cii_events',
      'india',
      'India',
      NULL,
      NULL,
      ARRAY['trade fair', 'agri', 'food export', 'ai', 'startup', 'industry'],
      0.88::numeric,
      720,
      true
    ),
    (
      'Agri Intex CODISSIA',
      'html',
      'https://agriintex.codissia.com/',
      'agri_trade_events',
      'india',
      'India',
      'Tamil Nadu',
      NULL,
      ARRAY['agritech', 'agri', 'trade fair', 'farm technology', 'india'],
      0.86::numeric,
      720,
      true
    ),
    (
      'UAS Bengaluru Krishi Mela Updates',
      'html',
      'https://uasbangalore.edu.in/',
      'agri_trade_events',
      'india',
      'India',
      'Karnataka',
      'Bengaluru',
      ARRAY['agritech', 'agri', 'krishi mela', 'karnataka', 'farm technology'],
      0.84::numeric,
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
