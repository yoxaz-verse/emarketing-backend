ALTER TABLE public.industry_intelligence_sources
  ADD COLUMN IF NOT EXISTS source_url text NULL,
  ADD COLUMN IF NOT EXISTS last_success_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS last_error text NULL,
  ADD COLUMN IF NOT EXISTS polling_interval_minutes integer NULL DEFAULT 360;

CREATE INDEX IF NOT EXISTS industry_intelligence_sources_polling_idx
  ON public.industry_intelligence_sources (status, supports_fetch, last_checked_at);

INSERT INTO public.industry_intelligence_sources
  (code, name, mode, source_url, region, sector_focus, supports_fetch, supports_manual, auth_ready, health_status, polling_interval_minutes, metadata)
VALUES
  ('startupindia', 'Startup India', 'api', 'https://www.startupindia.gov.in/content/sih/en/government-schemes.html', 'India', ARRAY['startup', 'agri-tech', 'technology'], true, true, false, 'configured_seed', 360, '{"priority":1,"parser":"html","source_url":"https://www.startupindia.gov.in/content/sih/en/government-schemes.html"}'::jsonb),
  ('agri_uddaan', 'Agri Udaan / Agritech Programs', 'api', 'https://aidea.naarm.org.in/', 'India', ARRAY['agri-tech', 'food-tech'], true, true, false, 'configured_seed', 360, '{"priority":2,"parser":"html","source_url":"https://aidea.naarm.org.in/"}'::jsonb),
  ('nasscom', 'NASSCOM / DeepTech Programs', 'api', 'https://www.nasscom.in/what-we-do/innovation-startups', 'India', ARRAY['technology', 'deeptech'], true, true, false, 'configured_seed', 360, '{"priority":3,"parser":"html","source_url":"https://www.nasscom.in/what-we-do/innovation-startups"}'::jsonb),
  ('yourstory', 'YourStory Funding News', 'rss', 'https://yourstory.com/feed', 'India', ARRAY['startup', 'funding'], true, true, false, 'configured_seed', 180, '{"priority":4,"parser":"rss","feed_url":"https://yourstory.com/feed"}'::jsonb),
  ('inc42', 'Inc42 Funding & Accelerators', 'rss', 'https://inc42.com/feed/', 'India', ARRAY['startup', 'funding'], true, true, false, 'configured_seed', 180, '{"priority":5,"parser":"rss","feed_url":"https://inc42.com/feed/"}'::jsonb),
  ('investindia', 'Invest India Programs', 'api', 'https://www.investindia.gov.in/schemes-for-startups', 'India', ARRAY['startup', 'agri-tech', 'export'], true, true, false, 'configured_seed', 360, '{"priority":6,"parser":"html","source_url":"https://www.investindia.gov.in/schemes-for-startups"}'::jsonb)
ON CONFLICT (code) DO UPDATE SET
  name = EXCLUDED.name,
  mode = EXCLUDED.mode,
  source_url = EXCLUDED.source_url,
  region = EXCLUDED.region,
  sector_focus = EXCLUDED.sector_focus,
  supports_fetch = EXCLUDED.supports_fetch,
  supports_manual = EXCLUDED.supports_manual,
  polling_interval_minutes = EXCLUDED.polling_interval_minutes,
  metadata = public.industry_intelligence_sources.metadata || EXCLUDED.metadata,
  updated_at = now();
