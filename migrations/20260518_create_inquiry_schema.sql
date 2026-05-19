-- Inquiry pipeline schema
-- Creates all tables required by Backend/src/services/inquiries/inquiries.service.ts

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE OR REPLACE FUNCTION public.inquiry_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

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

CREATE TABLE IF NOT EXISTS public.inquiry_fetch_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id uuid REFERENCES public.inquiry_sources(id) ON DELETE SET NULL,
  source_code text,
  trigger_mode text NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  total_received integer NOT NULL DEFAULT 0,
  inserted_count integer NOT NULL DEFAULT 0,
  deduped_count integer NOT NULL DEFAULT 0,
  failed_count integer NOT NULL DEFAULT 0,
  error_summary text,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  created_by uuid,
  operator_id uuid,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.source_connector_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fetch_run_id uuid REFERENCES public.inquiry_fetch_runs(id) ON DELETE CASCADE,
  source_id uuid REFERENCES public.inquiry_sources(id) ON DELETE SET NULL,
  source_code text,
  mode text NOT NULL,
  status text NOT NULL,
  latency_ms integer,
  fetched_count integer NOT NULL DEFAULT 0,
  inserted_count integer NOT NULL DEFAULT 0,
  deduped_count integer NOT NULL DEFAULT 0,
  failed_count integer NOT NULL DEFAULT 0,
  error_message text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.buyer_inquiries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inquiry_code text NOT NULL UNIQUE,
  source_id uuid REFERENCES public.inquiry_sources(id) ON DELETE SET NULL,
  source_code text,
  source_external_id text,
  fetch_run_id uuid REFERENCES public.inquiry_fetch_runs(id) ON DELETE SET NULL,
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
  coded_by uuid,
  raw_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  inquiry_received_at timestamptz,
  created_by uuid,
  operator_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT buyer_inquiries_stage_check CHECK (stage IN ('new', 'reviewed', 'qualified', 'follow_up', 'closed'))
);

CREATE TABLE IF NOT EXISTS public.inquiry_coding_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inquiry_id uuid NOT NULL REFERENCES public.buyer_inquiries(id) ON DELETE CASCADE,
  previous_stage text,
  new_stage text,
  changed_fields jsonb NOT NULL DEFAULT '{}'::jsonb,
  changed_by uuid,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.inquiry_quotes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_code text NOT NULL UNIQUE,
  inquiry_id uuid NOT NULL REFERENCES public.buyer_inquiries(id) ON DELETE CASCADE,
  price numeric,
  quantity text,
  currency text,
  incoterm text,
  validity_date text,
  terms text,
  status text NOT NULL DEFAULT 'draft',
  manual_sent_at timestamptz,
  sent_channel text,
  owner text,
  notes text,
  created_by uuid,
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT inquiry_quotes_status_check CHECK (status IN ('draft', 'reviewed', 'approved', 'sent', 'closed'))
);

CREATE TABLE IF NOT EXISTS public.inquiry_quote_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id uuid NOT NULL REFERENCES public.inquiry_quotes(id) ON DELETE CASCADE,
  previous_status text,
  new_status text,
  changed_fields jsonb NOT NULL DEFAULT '{}'::jsonb,
  changed_by uuid,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_inquiry_sources_status ON public.inquiry_sources(status);

CREATE INDEX IF NOT EXISTS idx_inquiry_fetch_runs_created_at ON public.inquiry_fetch_runs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_inquiry_fetch_runs_source_code ON public.inquiry_fetch_runs(source_code);
CREATE INDEX IF NOT EXISTS idx_inquiry_fetch_runs_status ON public.inquiry_fetch_runs(status);

CREATE INDEX IF NOT EXISTS idx_source_connector_runs_created_at ON public.source_connector_runs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_source_connector_runs_fetch_run_id ON public.source_connector_runs(fetch_run_id);
CREATE INDEX IF NOT EXISTS idx_source_connector_runs_source_code ON public.source_connector_runs(source_code);

CREATE INDEX IF NOT EXISTS idx_buyer_inquiries_created_at ON public.buyer_inquiries(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_buyer_inquiries_source_code ON public.buyer_inquiries(source_code);
CREATE INDEX IF NOT EXISTS idx_buyer_inquiries_stage ON public.buyer_inquiries(stage);
CREATE INDEX IF NOT EXISTS idx_buyer_inquiries_dedupe_hash ON public.buyer_inquiries(dedupe_hash);
CREATE INDEX IF NOT EXISTS idx_buyer_inquiries_source_external_id ON public.buyer_inquiries(source_external_id);
CREATE INDEX IF NOT EXISTS idx_buyer_inquiries_fetch_run_id ON public.buyer_inquiries(fetch_run_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_buyer_inquiries_source_external ON public.buyer_inquiries(source_code, source_external_id) WHERE source_external_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_inquiry_coding_events_inquiry_id ON public.inquiry_coding_events(inquiry_id);
CREATE INDEX IF NOT EXISTS idx_inquiry_coding_events_created_at ON public.inquiry_coding_events(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_inquiry_quotes_created_at ON public.inquiry_quotes(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_inquiry_quotes_inquiry_id ON public.inquiry_quotes(inquiry_id);
CREATE INDEX IF NOT EXISTS idx_inquiry_quotes_status ON public.inquiry_quotes(status);
CREATE INDEX IF NOT EXISTS idx_inquiry_quotes_owner ON public.inquiry_quotes(owner);

CREATE INDEX IF NOT EXISTS idx_inquiry_quote_events_quote_id ON public.inquiry_quote_events(quote_id);
CREATE INDEX IF NOT EXISTS idx_inquiry_quote_events_created_at ON public.inquiry_quote_events(created_at DESC);

DROP TRIGGER IF EXISTS trg_inquiry_sources_updated_at ON public.inquiry_sources;
CREATE TRIGGER trg_inquiry_sources_updated_at
BEFORE UPDATE ON public.inquiry_sources
FOR EACH ROW
EXECUTE FUNCTION public.inquiry_touch_updated_at();

DROP TRIGGER IF EXISTS trg_inquiry_fetch_runs_updated_at ON public.inquiry_fetch_runs;
CREATE TRIGGER trg_inquiry_fetch_runs_updated_at
BEFORE UPDATE ON public.inquiry_fetch_runs
FOR EACH ROW
EXECUTE FUNCTION public.inquiry_touch_updated_at();

DROP TRIGGER IF EXISTS trg_buyer_inquiries_updated_at ON public.buyer_inquiries;
CREATE TRIGGER trg_buyer_inquiries_updated_at
BEFORE UPDATE ON public.buyer_inquiries
FOR EACH ROW
EXECUTE FUNCTION public.inquiry_touch_updated_at();

DROP TRIGGER IF EXISTS trg_inquiry_quotes_updated_at ON public.inquiry_quotes;
CREATE TRIGGER trg_inquiry_quotes_updated_at
BEFORE UPDATE ON public.inquiry_quotes
FOR EACH ROW
EXECUTE FUNCTION public.inquiry_touch_updated_at();

INSERT INTO public.inquiry_sources (
  code,
  name,
  mode,
  status,
  supports_api,
  supports_webhook,
  supports_manual,
  supports_scrape,
  auth_ready,
  health_status,
  metadata
)
VALUES
  ('manual', 'Manual Intake', 'manual_webhook', 'active', false, true, true, false, false, 'fallback', '{"category":"utility","priority":0}'::jsonb),
  ('alibaba', 'Alibaba RFQ', 'api_webhook_manual', 'active', true, true, true, false, false, 'fallback', '{"category":"b2b","priority":1}'::jsonb),
  ('ec21', 'EC21', 'api_webhook_manual', 'active', true, true, true, false, false, 'fallback', '{"category":"b2b","priority":3}'::jsonb),
  ('ampliz_b2b', 'Ampliz B2B', 'manual_webhook', 'active', false, true, true, false, false, 'fallback', '{"category":"b2b","priority":29}'::jsonb),
  ('bizvibe', 'BizVibe', 'manual_webhook', 'active', false, true, true, false, false, 'fallback', '{"category":"b2b","priority":20}'::jsonb),
  ('dhgate', 'DHgate RFQ', 'manual_webhook', 'active', false, true, true, false, false, 'fallback', '{"category":"b2b","priority":10}'::jsonb),
  ('ecplaza', 'ECPlaza', 'manual_webhook', 'active', false, true, true, false, false, 'fallback', '{"category":"b2b","priority":9}'::jsonb)
ON CONFLICT (code) DO UPDATE
SET
  name = EXCLUDED.name,
  mode = EXCLUDED.mode,
  status = EXCLUDED.status,
  supports_api = EXCLUDED.supports_api,
  supports_webhook = EXCLUDED.supports_webhook,
  supports_manual = EXCLUDED.supports_manual,
  supports_scrape = EXCLUDED.supports_scrape,
  auth_ready = EXCLUDED.auth_ready,
  health_status = EXCLUDED.health_status,
  metadata = EXCLUDED.metadata,
  updated_at = now();
