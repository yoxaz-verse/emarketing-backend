-- One-time repair: requeue running-campaign leads whose assigned inbox
-- is no longer selected for that campaign.

update public.campaign_leads cl
set
  assigned_inbox_id = null,
  status = 'queued',
  status_reason = 'requeued_invalid_inbox_assignment',
  processing_at = null,
  execution_id = null
from public.campaigns c
where cl.campaign_id = c.id
  and c.status = 'running'
  and cl.status in ('queued', 'processing')
  and cl.assigned_inbox_id is not null
  and not exists (
    select 1
    from public.campaign_inboxes ci
    where ci.campaign_id = cl.campaign_id
      and ci.inbox_id = cl.assigned_inbox_id
  );
