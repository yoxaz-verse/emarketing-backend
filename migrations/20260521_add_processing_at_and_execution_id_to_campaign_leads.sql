-- Adds fields used by stale-processing recovery in campaign execution flow.
-- Safe to run multiple times.

alter table public.campaign_leads
  add column if not exists processing_at timestamptz null,
  add column if not exists execution_id text null;

create index if not exists idx_campaign_leads_status_processing_at
  on public.campaign_leads(status, processing_at);

create index if not exists idx_campaign_leads_campaign_status
  on public.campaign_leads(campaign_id, status);
