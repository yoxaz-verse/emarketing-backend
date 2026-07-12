CREATE TABLE IF NOT EXISTS public.event_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_name text NOT NULL,
  provider_type text NOT NULL CHECK (provider_type IN ('rss', 'ics', 'api')),
  source_url text NOT NULL,
  geography_scope text NOT NULL DEFAULT 'international'
    CHECK (geography_scope IN ('international', 'india', 'kerala', 'district')),
  country text NULL,
  state text NULL,
  district text NULL,
  categories text[] NOT NULL DEFAULT '{}',
  trust_score numeric(3,2) NOT NULL DEFAULT 0.70 CHECK (trust_score >= 0 AND trust_score <= 1),
  polling_interval_minutes integer NOT NULL DEFAULT 360 CHECK (polling_interval_minutes >= 15),
  active boolean NOT NULL DEFAULT true,
  last_ingested_at timestamptz NULL,
  last_error text NULL,
  created_by uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.event_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id uuid NULL REFERENCES public.event_sources(id) ON DELETE SET NULL,
  title text NOT NULL,
  description text NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NULL,
  timezone text NOT NULL DEFAULT 'UTC',
  location text NULL,
  geography_scope text NOT NULL DEFAULT 'international'
    CHECK (geography_scope IN ('international', 'india', 'kerala', 'district')),
  country text NULL,
  state text NULL,
  district text NULL,
  category text NULL,
  source_url text NULL,
  source_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  dedupe_hash text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'discovered'
    CHECK (status IN ('discovered', 'planned', 'ignored', 'expired')),
  planning_notes text NULL,
  countdown_meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid NULL,
  updated_by uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.event_ingestion_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id uuid NULL REFERENCES public.event_sources(id) ON DELETE SET NULL,
  status text NOT NULL CHECK (status IN ('success', 'partial', 'failed')),
  processed_count integer NOT NULL DEFAULT 0,
  inserted_count integer NOT NULL DEFAULT 0,
  skipped_count integer NOT NULL DEFAULT 0,
  error_count integer NOT NULL DEFAULT 0,
  errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NULL
);

CREATE INDEX IF NOT EXISTS event_sources_active_scope_idx
  ON public.event_sources (active, geography_scope, country, state, district);

CREATE INDEX IF NOT EXISTS event_items_upcoming_idx
  ON public.event_items (status, starts_at);

CREATE INDEX IF NOT EXISTS event_items_geo_idx
  ON public.event_items (geography_scope, country, state, district, starts_at);

CREATE INDEX IF NOT EXISTS event_items_source_idx
  ON public.event_items (source_id, starts_at);

CREATE INDEX IF NOT EXISTS event_ingestion_runs_source_started_idx
  ON public.event_ingestion_runs (source_id, started_at DESC);
