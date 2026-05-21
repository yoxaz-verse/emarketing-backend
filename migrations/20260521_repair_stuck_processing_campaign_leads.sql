-- One-time repair for active campaigns with legacy/stuck processing rows.
-- Safe to run multiple times.

with target_rows as (
  select cl.id
  from public.campaign_leads cl
  join public.campaigns c on c.id = cl.campaign_id
  where c.status = 'running'
    and cl.status = 'processing'
    and (
      cl.processing_at is null
      or cl.processing_at < (now() - interval '10 minutes')
    )
)
update public.campaign_leads cl
set
  status = 'queued',
  status_reason = 'requeued_processing_timeout',
  execution_id = null,
  processing_at = null
where cl.id in (select id from target_rows);
