-- Inquiry pipeline bootstrap migration
-- Safe to run multiple times.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 1) Source catalog
CREATE TABLE IF NOT EXISTS public.inquiry_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  mode text NOT NULL DEFAULT 'manual_webhook',
  status text NOT NULL DEFAULT 'active',
  webhook_secret text,
  supports_api boolean NOT NULL DEFAULT false,
  supports_webhook boolean NOT NULL DEFAULT true,
  supports_manual boolean NOT NULL DEFAULT true,
  supports_scrape boolean NOT NULL DEFAULT false,
  auth_ready boolean NOT NULL DEFAULT false,
  health_status text NOT NULL DEFAULT 'unknown',
  credentials_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_checked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 2) Fetch runs
CREATE TABLE IF NOT EXISTS public.inquiry_fetch_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id uuid,
  source_code text,
  trigger_mode text NOT NULL DEFAULT 'manual',
  status text NOT NULL DEFAULT 'running',
  total_received integer NOT NULL DEFAULT 0,
  inserted_count integer NOT NULL DEFAULT 0,
  deduped_count integer NOT NULL DEFAULT 0,
  failed_count integer NOT NULL DEFAULT 0,
  error_summary text,
  started_at timestamptz,
  completed_at timestamptz,
  created_by text,
  operator_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 3) Connector runs
CREATE TABLE IF NOT EXISTS public.source_connector_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fetch_run_id uuid,
  source_id uuid,
  source_code text,
  mode text NOT NULL,
  status text NOT NULL DEFAULT 'completed',
  latency_ms integer,
  fetched_count integer NOT NULL DEFAULT 0,
  inserted_count integer NOT NULL DEFAULT 0,
  deduped_count integer NOT NULL DEFAULT 0,
  failed_count integer NOT NULL DEFAULT 0,
  error_message text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 4) Inquiries
CREATE TABLE IF NOT EXISTS public.buyer_inquiries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inquiry_code text NOT NULL UNIQUE,
  source_id uuid,
  source_code text,
  source_external_id text,
  fetch_run_id uuid,
  dedupe_hash text,
  buyer_name text,
  buyer_company text,
  buyer_email text,
  buyer_phone text,
  buyer_country text,
  subject text,
  message text NOT NULL,
  quantity_requested text,
  product_interest text,
  quantity_band text,
  region text,
  urgency text,
  buyer_type text,
  stage text NOT NULL DEFAULT 'new',
  priority text,
  owner text,
  notes text,
  coded boolean NOT NULL DEFAULT false,
  coded_at timestamptz,
  coded_by text,
  raw_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  inquiry_received_at timestamptz,
  created_by text,
  operator_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 5) Quotes
CREATE TABLE IF NOT EXISTS public.inquiry_quotes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_code text NOT NULL UNIQUE,
  inquiry_id uuid NOT NULL,
  price numeric,
  quantity text,
  currency text,
  incoterm text,
  validity_date date,
  terms text,
  status text NOT NULL DEFAULT 'draft',
  manual_sent_at timestamptz,
  sent_channel text,
  owner text,
  notes text,
  created_by text,
  updated_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 6) Foreign keys (added only when absent)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema='public' AND table_name='inquiry_fetch_runs' AND constraint_name='inquiry_fetch_runs_source_id_fkey'
  ) THEN
    ALTER TABLE public.inquiry_fetch_runs
      ADD CONSTRAINT inquiry_fetch_runs_source_id_fkey
      FOREIGN KEY (source_id) REFERENCES public.inquiry_sources(id) ON DELETE SET NULL;
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema='public' AND table_name='source_connector_runs' AND constraint_name='source_connector_runs_fetch_run_id_fkey'
  ) THEN
    ALTER TABLE public.source_connector_runs
      ADD CONSTRAINT source_connector_runs_fetch_run_id_fkey
      FOREIGN KEY (fetch_run_id) REFERENCES public.inquiry_fetch_runs(id) ON DELETE SET NULL;
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema='public' AND table_name='source_connector_runs' AND constraint_name='source_connector_runs_source_id_fkey'
  ) THEN
    ALTER TABLE public.source_connector_runs
      ADD CONSTRAINT source_connector_runs_source_id_fkey
      FOREIGN KEY (source_id) REFERENCES public.inquiry_sources(id) ON DELETE SET NULL;
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema='public' AND table_name='buyer_inquiries' AND constraint_name='buyer_inquiries_source_id_fkey'
  ) THEN
    ALTER TABLE public.buyer_inquiries
      ADD CONSTRAINT buyer_inquiries_source_id_fkey
      FOREIGN KEY (source_id) REFERENCES public.inquiry_sources(id) ON DELETE SET NULL;
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema='public' AND table_name='buyer_inquiries' AND constraint_name='buyer_inquiries_fetch_run_id_fkey'
  ) THEN
    ALTER TABLE public.buyer_inquiries
      ADD CONSTRAINT buyer_inquiries_fetch_run_id_fkey
      FOREIGN KEY (fetch_run_id) REFERENCES public.inquiry_fetch_runs(id) ON DELETE SET NULL;
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema='public' AND table_name='inquiry_quotes' AND constraint_name='inquiry_quotes_inquiry_id_fkey'
  ) THEN
    ALTER TABLE public.inquiry_quotes
      ADD CONSTRAINT inquiry_quotes_inquiry_id_fkey
      FOREIGN KEY (inquiry_id) REFERENCES public.buyer_inquiries(id) ON DELETE CASCADE;
  END IF;
END$$;

-- 7) Indexes
CREATE INDEX IF NOT EXISTS idx_inquiry_sources_status ON public.inquiry_sources(status);
CREATE INDEX IF NOT EXISTS idx_inquiry_sources_code ON public.inquiry_sources(code);

CREATE INDEX IF NOT EXISTS idx_inquiry_fetch_runs_created_at ON public.inquiry_fetch_runs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_inquiry_fetch_runs_source_code ON public.inquiry_fetch_runs(source_code);

CREATE INDEX IF NOT EXISTS idx_source_connector_runs_created_at ON public.source_connector_runs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_source_connector_runs_fetch_run_id ON public.source_connector_runs(fetch_run_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_buyer_inquiries_source_external_unique
  ON public.buyer_inquiries(source_code, source_external_id)
  WHERE source_external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_buyer_inquiries_dedupe_hash ON public.buyer_inquiries(dedupe_hash);
CREATE INDEX IF NOT EXISTS idx_buyer_inquiries_created_at ON public.buyer_inquiries(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_buyer_inquiries_source_code ON public.buyer_inquiries(source_code);
CREATE INDEX IF NOT EXISTS idx_buyer_inquiries_stage ON public.buyer_inquiries(stage);
CREATE INDEX IF NOT EXISTS idx_buyer_inquiries_coded ON public.buyer_inquiries(coded);

CREATE INDEX IF NOT EXISTS idx_inquiry_quotes_created_at ON public.inquiry_quotes(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_inquiry_quotes_inquiry_id ON public.inquiry_quotes(inquiry_id);
CREATE INDEX IF NOT EXISTS idx_inquiry_quotes_status ON public.inquiry_quotes(status);

-- 8) Keep updated_at fresh
CREATE OR REPLACE FUNCTION public.set_updated_at_timestamp()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_inquiry_sources_updated_at ON public.inquiry_sources;
CREATE TRIGGER trg_inquiry_sources_updated_at
BEFORE UPDATE ON public.inquiry_sources
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at_timestamp();

DROP TRIGGER IF EXISTS trg_inquiry_fetch_runs_updated_at ON public.inquiry_fetch_runs;
CREATE TRIGGER trg_inquiry_fetch_runs_updated_at
BEFORE UPDATE ON public.inquiry_fetch_runs
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at_timestamp();

DROP TRIGGER IF EXISTS trg_buyer_inquiries_updated_at ON public.buyer_inquiries;
CREATE TRIGGER trg_buyer_inquiries_updated_at
BEFORE UPDATE ON public.buyer_inquiries
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at_timestamp();

DROP TRIGGER IF EXISTS trg_inquiry_quotes_updated_at ON public.inquiry_quotes;
CREATE TRIGGER trg_inquiry_quotes_updated_at
BEFORE UPDATE ON public.inquiry_quotes
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at_timestamp();

-- 9) Seed core inquiry sources
INSERT INTO public.inquiry_sources (code, name, mode, status, supports_api, supports_webhook, supports_manual, supports_scrape, auth_ready, health_status, metadata)
VALUES
  ('manual', 'Manual Intake', 'manual_webhook', 'active', false, true, true, false, false, 'fallback', '{"category":"utility","priority":0}'::jsonb),
  ('alibaba', 'Alibaba RFQ', 'api_webhook_manual', 'active', true, true, true, false, false, 'fallback', '{"category":"b2b","priority":1}'::jsonb),
  ('indiamart', 'IndiaMART', 'api_webhook_manual', 'active', true, true, true, false, false, 'fallback', '{"category":"b2b","priority":5}'::jsonb)
ON CONFLICT (code) DO UPDATE
SET
  name = EXCLUDED.name,
  mode = EXCLUDED.mode,
  status = EXCLUDED.status,
  supports_api = EXCLUDED.supports_api,
  supports_webhook = EXCLUDED.supports_webhook,
  supports_manual = EXCLUDED.supports_manual,
  supports_scrape = EXCLUDED.supports_scrape,
  health_status = EXCLUDED.health_status,
  metadata = COALESCE(public.inquiry_sources.metadata, '{}'::jsonb) || EXCLUDED.metadata,
  updated_at = now();
