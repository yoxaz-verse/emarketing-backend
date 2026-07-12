CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.industry_intelligence_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text UNIQUE NOT NULL,
  name text NOT NULL,
  mode text NOT NULL DEFAULT 'manual',
  status text NOT NULL DEFAULT 'active',
  region text NULL DEFAULT 'India',
  sector_focus text[] NOT NULL DEFAULT '{}'::text[],
  supports_fetch boolean NOT NULL DEFAULT false,
  supports_manual boolean NOT NULL DEFAULT true,
  auth_ready boolean NOT NULL DEFAULT false,
  health_status text NOT NULL DEFAULT 'unknown',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_checked_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT industry_intelligence_sources_mode_check
    CHECK (mode IN ('manual', 'rss', 'api', 'webhook')),
  CONSTRAINT industry_intelligence_sources_status_check
    CHECK (status IN ('active', 'paused', 'disabled'))
);

CREATE TABLE IF NOT EXISTS public.industry_intelligence_fetch_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_code text NULL,
  trigger_mode text NOT NULL DEFAULT 'source_fetch',
  status text NOT NULL DEFAULT 'running',
  total_received integer NOT NULL DEFAULT 0,
  inserted_count integer NOT NULL DEFAULT 0,
  deduped_count integer NOT NULL DEFAULT 0,
  failed_count integer NOT NULL DEFAULT 0,
  error_summary text NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz NULL,
  created_by uuid NULL,
  operator_id uuid NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT industry_intelligence_fetch_runs_status_check
    CHECK (status IN ('running', 'completed', 'completed_with_errors', 'failed'))
);

CREATE TABLE IF NOT EXISTS public.industry_intelligence_opportunities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id uuid NULL REFERENCES public.industry_intelligence_sources(id) ON DELETE SET NULL,
  source_code text NULL,
  source_name text NULL,
  source_url text NULL,
  title text NOT NULL,
  summary text NULL,
  category text NOT NULL DEFAULT 'seed_funding',
  sector text NULL,
  geography text NULL DEFAULT 'India',
  funding_stage text NULL,
  amount_text text NULL,
  deadline_date date NULL,
  opportunity_date timestamptz NULL,
  organizer_or_investor text NULL,
  relevance_score integer NULL,
  status text NOT NULL DEFAULT 'new',
  owner text NULL,
  notes text NULL,
  tags text[] NOT NULL DEFAULT '{}'::text[],
  useful_for_funding boolean NOT NULL DEFAULT true,
  useful_for_clients boolean NOT NULL DEFAULT false,
  useful_for_partnerships boolean NOT NULL DEFAULT false,
  useful_for_content boolean NOT NULL DEFAULT false,
  dedupe_hash text UNIQUE,
  raw_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  fetched_run_id uuid NULL REFERENCES public.industry_intelligence_fetch_runs(id) ON DELETE SET NULL,
  created_by uuid NULL,
  operator_id uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT industry_intelligence_opportunities_category_check
    CHECK (category IN (
      'seed_funding',
      'grant',
      'accelerator',
      'pitch_event',
      'demo_day',
      'investor_call',
      'ecosystem_program'
    )),
  CONSTRAINT industry_intelligence_opportunities_status_check
    CHECK (status IN (
      'new',
      'reviewed',
      'shortlisted',
      'applied',
      'not_relevant',
      'closed'
    )),
  CONSTRAINT industry_intelligence_opportunities_relevance_score_check
    CHECK (relevance_score IS NULL OR (relevance_score >= 0 AND relevance_score <= 100))
);

CREATE OR REPLACE FUNCTION public.set_industry_intelligence_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS industry_intelligence_sources_updated_at
  ON public.industry_intelligence_sources;
CREATE TRIGGER industry_intelligence_sources_updated_at
  BEFORE UPDATE ON public.industry_intelligence_sources
  FOR EACH ROW
  EXECUTE FUNCTION public.set_industry_intelligence_updated_at();

DROP TRIGGER IF EXISTS industry_intelligence_opportunities_updated_at
  ON public.industry_intelligence_opportunities;
CREATE TRIGGER industry_intelligence_opportunities_updated_at
  BEFORE UPDATE ON public.industry_intelligence_opportunities
  FOR EACH ROW
  EXECUTE FUNCTION public.set_industry_intelligence_updated_at();

CREATE INDEX IF NOT EXISTS industry_intelligence_sources_status_idx
  ON public.industry_intelligence_sources (status, name);

CREATE INDEX IF NOT EXISTS industry_intelligence_fetch_runs_created_idx
  ON public.industry_intelligence_fetch_runs (created_at DESC);

CREATE INDEX IF NOT EXISTS industry_intelligence_opportunities_review_idx
  ON public.industry_intelligence_opportunities (status, relevance_score DESC, created_at DESC);

CREATE INDEX IF NOT EXISTS industry_intelligence_opportunities_source_idx
  ON public.industry_intelligence_opportunities (source_code, created_at DESC);

CREATE INDEX IF NOT EXISTS industry_intelligence_opportunities_category_idx
  ON public.industry_intelligence_opportunities (category, created_at DESC);

INSERT INTO public.industry_intelligence_sources
  (code, name, mode, region, sector_focus, supports_fetch, supports_manual, auth_ready, health_status, metadata)
VALUES
  ('startupindia', 'Startup India', 'api', 'India', ARRAY['startup', 'agri-tech', 'technology'], true, true, false, 'configured_seed', '{"priority":1,"notes":"Configure API/feed metadata when available."}'::jsonb),
  ('agri_uddaan', 'Agri Udaan / Agritech Programs', 'manual', 'India', ARRAY['agri-tech', 'food-tech'], false, true, false, 'manual_seed', '{"priority":2,"notes":"Manual or webhook import for agri-tech program opportunities."}'::jsonb),
  ('nasscom', 'NASSCOM / DeepTech Programs', 'rss', 'India', ARRAY['technology', 'deeptech'], true, true, false, 'configured_seed', '{"priority":3,"notes":"Add feed_url in metadata for RSS ingestion."}'::jsonb),
  ('yourstory', 'YourStory Funding News', 'rss', 'India', ARRAY['startup', 'funding'], true, true, false, 'configured_seed', '{"priority":4,"notes":"Add feed_url in metadata for RSS ingestion."}'::jsonb),
  ('inc42', 'Inc42 Funding & Accelerators', 'rss', 'India', ARRAY['startup', 'funding'], true, true, false, 'configured_seed', '{"priority":5,"notes":"Add feed_url in metadata for RSS ingestion."}'::jsonb),
  ('investindia', 'Invest India Programs', 'api', 'India', ARRAY['startup', 'agri-tech', 'export'], true, true, false, 'configured_seed', '{"priority":6,"notes":"Configure API/feed metadata when available."}'::jsonb)
ON CONFLICT (code) DO UPDATE SET
  name = EXCLUDED.name,
  mode = EXCLUDED.mode,
  region = EXCLUDED.region,
  sector_focus = EXCLUDED.sector_focus,
  supports_fetch = EXCLUDED.supports_fetch,
  supports_manual = EXCLUDED.supports_manual,
  metadata = public.industry_intelligence_sources.metadata || EXCLUDED.metadata,
  updated_at = now();
