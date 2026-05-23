-- Reply capture runtime stabilization (safe, idempotent)
-- Ensures FK delete behavior + performance indexes for strict reply tracking.

BEGIN;

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

CREATE INDEX IF NOT EXISTS idx_email_logs_campaign_status_sent_at
  ON public.email_logs(campaign_id, status, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_logs_provider_message_id
  ON public.email_logs(provider_message_id);
CREATE INDEX IF NOT EXISTS idx_email_logs_campaign_lead_id
  ON public.email_logs(campaign_lead_id);

CREATE INDEX IF NOT EXISTS idx_email_tracking_event_type_campaign_event_at
  ON public.email_tracking_events(event_type, campaign_id, event_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_tracking_provider_message_id
  ON public.email_tracking_events(provider_message_id);

CREATE INDEX IF NOT EXISTS idx_reply_ingest_matched_received_at
  ON public.reply_ingest_events(matched, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_reply_ingest_message_id
  ON public.reply_ingest_events(message_id);
CREATE INDEX IF NOT EXISTS idx_reply_ingest_from_inbox
  ON public.reply_ingest_events(from_email, inbox_email);

COMMIT;
