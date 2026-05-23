-- Reply capture sanity checks (read-only)
-- Run after deploy to verify strict reply tracking integrity.

-- 1) Matched ingest rows missing strict reply events
SELECT
  rie.id AS reply_ingest_event_id,
  rie.message_id,
  rie.lead_id,
  rie.received_at
FROM public.reply_ingest_events rie
WHERE rie.matched = true
  AND NOT EXISTS (
    SELECT 1
    FROM public.email_tracking_events ete
    WHERE ete.event_type = 'reply'
      AND (
        (rie.message_id IS NOT NULL AND lower(coalesce(ete.provider_message_id, '')) = lower(rie.message_id))
        OR (ete.lead_id = rie.lead_id AND abs(extract(epoch from (ete.event_at - rie.received_at))) <= 86400)
      )
  )
ORDER BY rie.received_at DESC
LIMIT 200;

-- 2) Strict reply events with null campaign linkage despite resolvable message-id
SELECT
  ete.id AS tracking_event_id,
  ete.provider_message_id,
  ete.lead_id,
  ete.event_at
FROM public.email_tracking_events ete
JOIN public.email_logs el
  ON lower(coalesce(el.provider_message_id, '')) = lower(coalesce(ete.provider_message_id, ''))
WHERE ete.event_type = 'reply'
  AND ete.provider_message_id IS NOT NULL
  AND (ete.campaign_id IS NULL OR ete.campaign_lead_id IS NULL)
ORDER BY ete.event_at DESC
LIMIT 200;

-- 3) Potential duplicate semantic reply events (different dedupe keys)
SELECT
  coalesce(provider_message_id, '[no_message_id]') AS provider_message_id,
  coalesce(lead_id::text, '[no_lead]') AS lead_id,
  date_trunc('minute', event_at) AS minute_bucket,
  count(*) AS event_count
FROM public.email_tracking_events
WHERE event_type = 'reply'
GROUP BY 1, 2, 3
HAVING count(*) > 1
ORDER BY minute_bucket DESC
LIMIT 200;

-- 4) Campaign leads marked replied but still missing strict reply events (effective fallback candidates)
SELECT
  cl.id AS campaign_lead_id,
  cl.campaign_id,
  cl.lead_id,
  cl.created_at
FROM public.campaign_leads cl
WHERE lower(coalesce(cl.status, '')) = 'replied'
  AND NOT EXISTS (
    SELECT 1
    FROM public.email_tracking_events ete
    WHERE ete.event_type = 'reply'
      AND ete.campaign_lead_id = cl.id
  )
ORDER BY cl.created_at DESC
LIMIT 200;

-- 5) Strict reply events present but unresolved campaign linkage despite matching sent message-id
SELECT
  ete.id AS tracking_event_id,
  ete.provider_message_id,
  ete.lead_id,
  ete.event_at
FROM public.email_tracking_events ete
WHERE ete.event_type = 'reply'
  AND (ete.campaign_id IS NULL OR ete.campaign_lead_id IS NULL)
  AND EXISTS (
    SELECT 1
    FROM public.email_logs el
    WHERE lower(coalesce(el.provider_message_id, '')) = lower(coalesce(ete.provider_message_id, ''))
  )
ORDER BY ete.event_at DESC
LIMIT 200;
