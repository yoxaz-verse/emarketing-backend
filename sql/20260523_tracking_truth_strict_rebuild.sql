-- Strict rebuild: campaign send control/tracking truth alignment.
-- Safe/idempotent where possible.

BEGIN;

-- 1) Ensure runtime columns exist for send logging + correlation.
ALTER TABLE IF EXISTS public.email_logs
  ADD COLUMN IF NOT EXISTS provider_name text,
  ADD COLUMN IF NOT EXISTS provider_message_id text,
  ADD COLUMN IF NOT EXISTS campaign_id uuid,
  ADD COLUMN IF NOT EXISTS campaign_lead_id uuid,
  ADD COLUMN IF NOT EXISTS to_email text;

ALTER TABLE IF EXISTS public.email_tracking_events
  ADD COLUMN IF NOT EXISTS provider_name text,
  ADD COLUMN IF NOT EXISTS provider_message_id text,
  ADD COLUMN IF NOT EXISTS campaign_id uuid,
  ADD COLUMN IF NOT EXISTS campaign_lead_id uuid,
  ADD COLUMN IF NOT EXISTS lead_id uuid,
  ADD COLUMN IF NOT EXISTS inbox_id uuid,
  ADD COLUMN IF NOT EXISTS from_email text,
  ADD COLUMN IF NOT EXISTS to_email text,
  ADD COLUMN IF NOT EXISTS event_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS matched boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS raw_payload jsonb NOT NULL DEFAULT '{}'::jsonb;

-- 2) Preserve history when campaign_leads are deleted.
ALTER TABLE IF EXISTS public.email_tracking_events
  ALTER COLUMN campaign_lead_id DROP NOT NULL;
ALTER TABLE IF EXISTS public.email_logs
  ALTER COLUMN campaign_lead_id DROP NOT NULL;

ALTER TABLE IF EXISTS public.email_tracking_events
  DROP CONSTRAINT IF EXISTS email_tracking_events_campaign_lead_id_fkey;
ALTER TABLE IF EXISTS public.email_tracking_events
  ADD CONSTRAINT email_tracking_events_campaign_lead_id_fkey
  FOREIGN KEY (campaign_lead_id) REFERENCES public.campaign_leads(id) ON DELETE SET NULL;

ALTER TABLE IF EXISTS public.email_logs
  DROP CONSTRAINT IF EXISTS email_logs_campaign_lead_id_fkey;
ALTER TABLE IF EXISTS public.email_logs
  ADD CONSTRAINT email_logs_campaign_lead_id_fkey
  FOREIGN KEY (campaign_lead_id) REFERENCES public.campaign_leads(id) ON DELETE SET NULL;

-- 3) Keep/add campaign FK on logs.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE table_schema = 'public'
      AND table_name = 'email_logs'
      AND constraint_name = 'email_logs_campaign_id_fkey'
  ) THEN
    ALTER TABLE public.email_logs
      ADD CONSTRAINT email_logs_campaign_id_fkey
      FOREIGN KEY (campaign_id) REFERENCES public.campaigns(id);
  END IF;
END$$;

-- 4) Core indexes for throttle/correlation/analytics.
CREATE INDEX IF NOT EXISTS idx_email_logs_campaign_id_status_sent_at
  ON public.email_logs(campaign_id, status, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_logs_campaign_id_sent_at
  ON public.email_logs(campaign_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_logs_provider_message_id
  ON public.email_logs(provider_message_id);
CREATE INDEX IF NOT EXISTS idx_email_logs_campaign_lead_id
  ON public.email_logs(campaign_lead_id);
CREATE INDEX IF NOT EXISTS idx_email_logs_to_email_sent_at
  ON public.email_logs(to_email, sent_at DESC);

CREATE INDEX IF NOT EXISTS idx_email_tracking_events_campaign_id_event_at
  ON public.email_tracking_events(campaign_id, event_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_tracking_events_campaign_lead_id
  ON public.email_tracking_events(campaign_lead_id);
CREATE INDEX IF NOT EXISTS idx_email_tracking_events_provider_message_id
  ON public.email_tracking_events(provider_message_id);
CREATE INDEX IF NOT EXISTS idx_email_tracking_events_event_type
  ON public.email_tracking_events(event_type);

CREATE INDEX IF NOT EXISTS idx_reply_ingest_events_received_at_matched
  ON public.reply_ingest_events(received_at DESC, matched);

COMMIT;
