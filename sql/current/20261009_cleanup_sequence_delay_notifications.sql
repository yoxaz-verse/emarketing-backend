begin;

-- Expected sequence-delay checks are execution diagnostics, not actionable
-- communications. Remove pending projections first so they cannot recreate
-- feed items after the cleanup. Historical system_events remain untouched.
delete from public.communication_queue
where source_table = 'system_events'
  and payload->>'type' = 'CAMPAIGN_SEQUENCE_DELAY_BLOCKED';

delete from public.communication_items as item
where item.kind = 'notification'
  and exists (
    select 1
    from public.system_events as event
    where item.source_key = 'system_events:' || event.id::text
      and event.type = 'CAMPAIGN_SEQUENCE_DELAY_BLOCKED'
  );

commit;
