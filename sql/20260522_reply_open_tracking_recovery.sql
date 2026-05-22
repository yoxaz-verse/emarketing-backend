-- MXroute reply/open tracking recovery patch
-- Safe to run multiple times where possible.

-- 1) email_logs columns used by correlation and analytics
ALTER TABLE public.email_logs
  ADD COLUMN IF NOT EXISTS provider_message_id text,
  ADD COLUMN IF NOT EXISTS campaign_id uuid,
  ADD COLUMN IF NOT EXISTS campaign_lead_id uuid,
  ADD COLUMN IF NOT EXISTS to_email text;

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

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE table_schema = 'public'
      AND table_name = 'email_logs'
      AND constraint_name = 'email_logs_campaign_lead_id_fkey'
  ) THEN
    ALTER TABLE public.email_logs
      ADD CONSTRAINT email_logs_campaign_lead_id_fkey
      FOREIGN KEY (campaign_lead_id) REFERENCES public.campaign_leads(id);
  END IF;
END$$;

-- 2) lead review fields for Replies queue
ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS interest_status text,
  ADD COLUMN IF NOT EXISTS interest_note text,
  ADD COLUMN IF NOT EXISTS interest_reviewed_at timestamp with time zone,
  ADD COLUMN IF NOT EXISTS interest_reviewed_by text;

UPDATE public.leads
SET interest_status = COALESCE(NULLIF(TRIM(interest_status), ''), 'unreviewed')
WHERE interest_status IS NULL OR TRIM(interest_status) = '';

-- 3) reply ingest events
CREATE TABLE IF NOT EXISTS public.reply_ingest_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dedupe_key text NOT NULL UNIQUE,
  lead_id uuid REFERENCES public.leads(id),
  matched boolean NOT NULL DEFAULT false,
  from_email text,
  inbox_email text,
  message_id text,
  message text,
  received_at timestamp with time zone NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

-- 4) email tracking events (open/delivery/reply/bounce truth)
CREATE TABLE IF NOT EXISTS public.email_tracking_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dedupe_key text NOT NULL UNIQUE,
  event_type text NOT NULL,
  provider_name text,
  provider_message_id text,
  campaign_id uuid REFERENCES public.campaigns(id),
  campaign_lead_id uuid REFERENCES public.campaign_leads(id),
  lead_id uuid REFERENCES public.leads(id),
  inbox_id uuid REFERENCES public.inboxes(id),
  from_email text,
  to_email text,
  event_at timestamp with time zone NOT NULL,
  matched boolean NOT NULL DEFAULT false,
  raw_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

-- 5) indexes for lookup and analytics
CREATE INDEX IF NOT EXISTS idx_email_logs_provider_message_id ON public.email_logs(provider_message_id);
CREATE INDEX IF NOT EXISTS idx_email_logs_campaign_id_sent_at ON public.email_logs(campaign_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_logs_campaign_lead_id ON public.email_logs(campaign_lead_id);
CREATE INDEX IF NOT EXISTS idx_email_logs_to_email_sent_at ON public.email_logs(to_email, sent_at DESC);

CREATE INDEX IF NOT EXISTS idx_reply_ingest_events_received_at ON public.reply_ingest_events(received_at DESC);
CREATE INDEX IF NOT EXISTS idx_reply_ingest_events_matched ON public.reply_ingest_events(matched);
CREATE INDEX IF NOT EXISTS idx_reply_ingest_events_lead_id ON public.reply_ingest_events(lead_id);
CREATE INDEX IF NOT EXISTS idx_reply_ingest_events_inbox_email ON public.reply_ingest_events(inbox_email);
CREATE INDEX IF NOT EXISTS idx_reply_ingest_events_from_email ON public.reply_ingest_events(from_email);
CREATE INDEX IF NOT EXISTS idx_reply_ingest_events_message_id ON public.reply_ingest_events(message_id);

CREATE INDEX IF NOT EXISTS idx_email_tracking_events_campaign_id_event_at ON public.email_tracking_events(campaign_id, event_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_tracking_events_campaign_lead_id ON public.email_tracking_events(campaign_lead_id);
CREATE INDEX IF NOT EXISTS idx_email_tracking_events_lead_id ON public.email_tracking_events(lead_id);
CREATE INDEX IF NOT EXISTS idx_email_tracking_events_provider_message_id ON public.email_tracking_events(provider_message_id);
CREATE INDEX IF NOT EXISTS idx_email_tracking_events_event_type ON public.email_tracking_events(event_type);

-- 6) gentle defaults for status values
UPDATE public.leads
SET interest_status = 'unreviewed'
WHERE interest_status IS NULL;

