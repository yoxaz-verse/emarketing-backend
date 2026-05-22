-- Preserve tracking history when campaign_leads are removed.
-- This migration makes campaign_lead foreign keys nullable on delete.

BEGIN;

-- Safety: ensure nullable columns before adding ON DELETE SET NULL constraints.
ALTER TABLE IF EXISTS public.email_tracking_events
  ALTER COLUMN campaign_lead_id DROP NOT NULL;

ALTER TABLE IF EXISTS public.email_logs
  ALTER COLUMN campaign_lead_id DROP NOT NULL;

-- Recreate campaign_lead FK on email_tracking_events with ON DELETE SET NULL.
ALTER TABLE IF EXISTS public.email_tracking_events
  DROP CONSTRAINT IF EXISTS email_tracking_events_campaign_lead_id_fkey;

ALTER TABLE IF EXISTS public.email_tracking_events
  ADD CONSTRAINT email_tracking_events_campaign_lead_id_fkey
  FOREIGN KEY (campaign_lead_id)
  REFERENCES public.campaign_leads(id)
  ON DELETE SET NULL;

-- Recreate campaign_lead FK on email_logs with ON DELETE SET NULL.
ALTER TABLE IF EXISTS public.email_logs
  DROP CONSTRAINT IF EXISTS email_logs_campaign_lead_id_fkey;

ALTER TABLE IF EXISTS public.email_logs
  ADD CONSTRAINT email_logs_campaign_lead_id_fkey
  FOREIGN KEY (campaign_lead_id)
  REFERENCES public.campaign_leads(id)
  ON DELETE SET NULL;

COMMIT;

