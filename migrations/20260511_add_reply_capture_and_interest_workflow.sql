ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS interest_status text NOT NULL DEFAULT 'unreviewed',
  ADD COLUMN IF NOT EXISTS interest_note text,
  ADD COLUMN IF NOT EXISTS interest_reviewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS interest_reviewed_by text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'leads_interest_status_check'
  ) THEN
    ALTER TABLE public.leads
      ADD CONSTRAINT leads_interest_status_check
      CHECK (interest_status IN ('unreviewed','interested','not_interested'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.reply_ingest_events (
  id bigserial PRIMARY KEY,
  dedupe_key text NOT NULL UNIQUE,
  lead_id uuid,
  matched boolean NOT NULL DEFAULT false,
  from_email text,
  inbox_email text,
  message_id text,
  message text,
  received_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_reply_ingest_events_lead_id
  ON public.reply_ingest_events (lead_id);

CREATE INDEX IF NOT EXISTS idx_reply_ingest_events_created_at
  ON public.reply_ingest_events (created_at DESC);
