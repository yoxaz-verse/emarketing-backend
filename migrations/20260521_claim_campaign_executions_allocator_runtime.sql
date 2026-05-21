-- Runtime override: claim queued rows even when assigned_inbox_id is null.
-- Sender assignment is resolved in backend allocator at send time.

create or replace function public.claim_campaign_executions(
  p_campaign_id text,
  p_limit integer
)
returns table (
  id text,
  campaign_lead_id text,
  execution_id text
)
language plpgsql
as $$
declare
  v_limit integer := greatest(coalesce(p_limit, 0), 0);
begin
  if v_limit = 0 then
    return;
  end if;

  return query
  with locked as (
    select cl.id
    from public.campaign_leads cl
    join public.campaigns c
      on c.id = cl.campaign_id
    where cl.campaign_id = p_campaign_id
      and c.status = 'running'
      and cl.status = 'queued'
    order by cl.created_at asc
    for update of cl skip locked
    limit v_limit
  ), updated as (
    update public.campaign_leads cl
    set
      status = 'processing',
      processing_at = now(),
      execution_id = md5(random()::text || clock_timestamp()::text || cl.id::text)
    where cl.id in (select id from locked)
    returning cl.id, cl.execution_id
  )
  select
    updated.id::text as id,
    updated.id::text as campaign_lead_id,
    updated.execution_id::text as execution_id
  from updated;
end;
$$;
