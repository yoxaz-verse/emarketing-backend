-- Reply hybrid recovery + status alignment (safe, idempotent)
-- 1) Ensure campaign_leads status allows 'replied'
-- 2) Backfill missing strict reply tracking events from matched reply_ingest_events

BEGIN;

DO $$
DECLARE
  v_name text;
BEGIN
  SELECT conname INTO v_name
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  WHERE n.nspname = 'public'
    AND t.relname = 'campaign_leads'
    AND c.contype = 'c'
    AND pg_get_constraintdef(c.oid) ILIKE '%status%';

  IF v_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.campaign_leads DROP CONSTRAINT %I', v_name);
  END IF;

  ALTER TABLE public.campaign_leads
    ADD CONSTRAINT campaign_leads_status_check
    CHECK (status = ANY (ARRAY['queued'::text, 'processing'::text, 'completed'::text, 'failed'::text, 'paused'::text, 'replied'::text]));
END $$;

WITH candidate_replies AS (
  SELECT
    rie.id AS reply_ingest_event_id,
    rie.dedupe_key,
    lower(nullif(rie.message_id, '')) AS provider_message_id,
    rie.lead_id,
    rie.from_email,
    rie.inbox_email,
    rie.received_at,
    el.campaign_id,
    el.campaign_lead_id,
    el.inbox_id,
    lower(nullif(el.to_email, '')) AS to_email,
    CASE WHEN el.campaign_lead_id IS NOT NULL THEN 'high' ELSE 'medium' END AS correlation_confidence
  FROM public.reply_ingest_events rie
  LEFT JOIN LATERAL (
    SELECT
      l.campaign_id,
      l.campaign_lead_id,
      l.inbox_id,
      l.to_email,
      l.sent_at
    FROM public.email_logs l
    WHERE (
      rie.message_id IS NOT NULL
      AND lower(coalesce(l.provider_message_id, '')) = lower(rie.message_id)
    )
    OR (
      rie.message_id IS NULL
      AND rie.lead_id IS NOT NULL
      AND l.lead_id = rie.lead_id
      AND l.sent_at >= (rie.received_at - interval '14 days')
      AND l.sent_at <= (rie.received_at + interval '1 day')
    )
    ORDER BY l.sent_at DESC
    LIMIT 1
  ) el ON true
  WHERE rie.matched = true
),
missing_strict AS (
  SELECT c.*
  FROM candidate_replies c
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.email_tracking_events e
    WHERE e.event_type = 'reply'
      AND (
        (c.provider_message_id IS NOT NULL AND lower(coalesce(e.provider_message_id, '')) = c.provider_message_id)
        OR (
          c.lead_id IS NOT NULL
          AND e.lead_id = c.lead_id
          AND abs(extract(epoch from (e.event_at - c.received_at))) <= 86400
        )
      )
  )
)
INSERT INTO public.email_tracking_events (
  dedupe_key,
  event_type,
  provider_name,
  provider_message_id,
  campaign_id,
  campaign_lead_id,
  lead_id,
  inbox_id,
  from_email,
  to_email,
  event_at,
  matched,
  raw_payload
)
SELECT
  md5('reply_hybrid_backfill|' || m.reply_ingest_event_id::text || '|' || coalesce(m.campaign_lead_id::text, '') || '|' || coalesce(m.campaign_id::text, '')) AS dedupe_key,
  'reply'::text,
  'imap'::text,
  m.provider_message_id,
  m.campaign_id,
  m.campaign_lead_id,
  m.lead_id,
  m.inbox_id,
  m.from_email,
  m.to_email,
  m.received_at,
  (m.campaign_lead_id IS NOT NULL OR m.lead_id IS NOT NULL),
  jsonb_build_object(
    'source', 'hybrid_recovery_backfill',
    'ingested_via', 'sql_backfill',
    'reply_ingest_event_id', m.reply_ingest_event_id,
    'dedupe_key', m.dedupe_key,
    'correlation_confidence', m.correlation_confidence
  )
FROM missing_strict m;

COMMIT;
