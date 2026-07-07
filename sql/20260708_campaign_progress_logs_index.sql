-- Read-path index for campaign progress log round inference.

create index if not exists email_logs_campaign_lead_sent_idx
  on public.email_logs (campaign_id, campaign_lead_id, sent_at desc)
  where status = 'sent';
