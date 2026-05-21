-- Email event tracking for campaign analytics (open/reply)

create table if not exists public.email_tracking_events (
  id uuid primary key default gen_random_uuid(),
  dedupe_key text not null,
  event_type text not null,
  provider_name text null,
  provider_message_id text null,
  campaign_id uuid null,
  campaign_lead_id uuid null,
  lead_id uuid null,
  inbox_id uuid null,
  from_email text null,
  to_email text null,
  event_at timestamptz not null default now(),
  matched boolean not null default false,
  raw_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create unique index if not exists ux_email_tracking_events_dedupe_key
  on public.email_tracking_events(dedupe_key);

create index if not exists idx_email_tracking_events_campaign_id
  on public.email_tracking_events(campaign_id);

create index if not exists idx_email_tracking_events_campaign_lead_id
  on public.email_tracking_events(campaign_lead_id);

create index if not exists idx_email_tracking_events_event_type
  on public.email_tracking_events(event_type);

create index if not exists idx_email_tracking_events_provider_message_id
  on public.email_tracking_events(provider_message_id);

alter table public.email_logs
  add column if not exists provider_name text,
  add column if not exists provider_message_id text,
  add column if not exists campaign_id uuid,
  add column if not exists campaign_lead_id uuid,
  add column if not exists to_email text;

create index if not exists idx_email_logs_provider_message_id
  on public.email_logs(provider_message_id);

create index if not exists idx_email_logs_campaign_lead_id
  on public.email_logs(campaign_lead_id);
