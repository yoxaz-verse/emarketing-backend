-- Safe metadata backfill for missing campaign email_logs rows.
-- Strategy:
-- 1) Use system_events(email_sent) with campaign_lead_id + message_id as high-confidence source.
-- 2) Insert only rows that do not already exist by campaign_lead_id/message_id.
-- 3) Keep historical tracking rows intact and improve analytics linkage.

BEGIN;

-- Ensure runtime-required columns exist (idempotent safety for older databases).
ALTER TABLE IF EXISTS public.email_logs
  ADD COLUMN IF NOT EXISTS provider_name text,
  ADD COLUMN IF NOT EXISTS provider_message_id text,
  ADD COLUMN IF NOT EXISTS campaign_id uuid,
  ADD COLUMN IF NOT EXISTS campaign_lead_id uuid,
  ADD COLUMN IF NOT EXISTS to_email text;

WITH source_events AS (
  SELECT
    se.entity_id::uuid AS campaign_lead_id,
    NULLIF(lower(trim(se.meta->>'message_id')), '') AS provider_message_id,
    NULLIF(trim(se.meta->>'to'), '') AS to_email,
    NULLIF(trim(se.meta->>'inbox_id'), '')::uuid AS inbox_id,
    COALESCE(se.created_at, now())::timestamp without time zone AS sent_at,
    COALESCE(NULLIF(trim(se.meta->>'provider_name'), ''), 'smtp') AS provider_name
  FROM public.system_events se
  WHERE se.type = 'email_sent'
    AND se.entity_id IS NOT NULL
),
resolved AS (
  SELECT
    s.campaign_lead_id,
    cl.campaign_id,
    cl.lead_id,
    s.inbox_id,
    s.provider_name,
    s.provider_message_id,
    s.to_email,
    s.sent_at
  FROM source_events s
  JOIN public.campaign_leads cl
    ON cl.id = s.campaign_lead_id
  WHERE s.provider_message_id IS NOT NULL
),
eligible AS (
  SELECT r.*
  FROM resolved r
  LEFT JOIN public.email_logs el_cl
    ON el_cl.campaign_lead_id = r.campaign_lead_id
   AND el_cl.status = 'sent'
  LEFT JOIN public.email_logs el_mid
    ON el_mid.provider_message_id = r.provider_message_id
   AND el_mid.status = 'sent'
  WHERE el_cl.id IS NULL
    AND el_mid.id IS NULL
)
INSERT INTO public.email_logs (
  lead_id,
  inbox_id,
  campaign_id,
  campaign_lead_id,
  to_email,
  provider_name,
  provider_message_id,
  subject,
  body,
  status,
  sent_at
)
SELECT
  e.lead_id,
  e.inbox_id,
  e.campaign_id,
  e.campaign_lead_id,
  e.to_email,
  e.provider_name,
  e.provider_message_id,
  '[backfilled] subject unavailable',
  '[backfilled] body unavailable',
  'sent',
  e.sent_at
FROM eligible e;

COMMIT;
