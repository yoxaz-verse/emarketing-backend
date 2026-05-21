-- One-time repair: requeue processing rows that cannot safely send
-- due to missing or invalid sender assignment.

update public.campaign_leads cl
set
  status = 'queued',
  status_reason = 'requeued_invalid_sender_state',
  processing_at = null,
  execution_id = null,
  assigned_inbox_id = null
from public.campaigns c
where cl.campaign_id = c.id
  and c.status = 'running'
  and cl.status = 'processing'
  and (
    cl.assigned_inbox_id is null
    or not exists (
      select 1
      from public.campaign_inboxes ci
      where ci.campaign_id = cl.campaign_id
        and ci.inbox_id = cl.assigned_inbox_id
    )
    or exists (
      select 1
      from public.inboxes i
      where i.id = cl.assigned_inbox_id
        and (coalesce(i.hard_paused, false) = true or coalesce(i.is_paused, false) = true)
    )
  );
