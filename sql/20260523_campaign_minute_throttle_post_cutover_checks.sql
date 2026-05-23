-- Post-cutover checks for strict 1 email/minute/campaign enforcement.
-- Run after deploying backend + n8n cutover workflow.

-- 1) Any campaign/minute bucket with more than 1 sent mail in the last 24h.
SELECT
  el.campaign_id,
  date_trunc('minute', el.sent_at AT TIME ZONE 'UTC') AS minute_bucket_utc,
  COUNT(*) AS sent_count
FROM public.email_logs el
WHERE el.status = 'sent'
  AND el.sent_at >= (now() AT TIME ZONE 'UTC') - interval '24 hours'
GROUP BY 1, 2
HAVING COUNT(*) > 1
ORDER BY minute_bucket_utc DESC, sent_count DESC;

-- 2) Same check for the last 72h (wider confidence window).
SELECT
  el.campaign_id,
  date_trunc('minute', el.sent_at AT TIME ZONE 'UTC') AS minute_bucket_utc,
  COUNT(*) AS sent_count
FROM public.email_logs el
WHERE el.status = 'sent'
  AND el.sent_at >= (now() AT TIME ZONE 'UTC') - interval '72 hours'
GROUP BY 1, 2
HAVING COUNT(*) > 1
ORDER BY minute_bucket_utc DESC, sent_count DESC;

-- 3) Minute throttle events in the last 24h (should exist when second-attempt blocks happen).
SELECT
  se.created_at,
  se.entity_id AS campaign_id,
  se.message,
  to_jsonb(se)->'meta' AS meta,
  to_jsonb(se)->'payload' AS payload,
  to_jsonb(se)->'details' AS details
FROM public.system_events se
WHERE se.type = 'CAMPAIGN_MINUTE_THROTTLED'
  AND se.created_at >= (now() AT TIME ZONE 'UTC') - interval '24 hours'
ORDER BY se.created_at DESC
LIMIT 500;

-- 4) Optional per-campaign burst check (replace CAMPAIGN_UUID before running).
-- SELECT
--   date_trunc('minute', el.sent_at AT TIME ZONE 'UTC') AS minute_bucket_utc,
--   COUNT(*) AS sent_count
-- FROM public.email_logs el
-- WHERE el.status = 'sent'
--   AND el.campaign_id = 'CAMPAIGN_UUID'
--   AND el.sent_at >= (now() AT TIME ZONE 'UTC') - interval '24 hours'
-- GROUP BY 1
-- HAVING COUNT(*) > 1
-- ORDER BY minute_bucket_utc DESC;
