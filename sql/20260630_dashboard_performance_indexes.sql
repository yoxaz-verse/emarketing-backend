-- Read-path indexes for dashboard pagination, campaign workspace summaries,
-- and tracking/runner health lookups. All statements are idempotent.

create index if not exists campaign_leads_campaign_status_step_idx
  on public.campaign_leads (campaign_id, status, current_step);

create index if not exists campaign_leads_campaign_created_idx
  on public.campaign_leads (campaign_id, created_at desc);

create index if not exists leads_operator_created_idx
  on public.leads (operator_id, created_at desc, id);

create index if not exists leads_operator_folder_created_idx
  on public.leads (operator_id, folder_id, created_at desc);

create index if not exists campaign_inboxes_campaign_inbox_idx
  on public.campaign_inboxes (campaign_id, inbox_id);

create index if not exists email_logs_campaign_status_sent_idx
  on public.email_logs (campaign_id, status, sent_at desc);

create index if not exists email_tracking_events_campaign_event_idx
  on public.email_tracking_events (campaign_id, event_at desc);

create index if not exists system_events_entity_type_created_idx
  on public.system_events (entity_id, type, created_at desc);
