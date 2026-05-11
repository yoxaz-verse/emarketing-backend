-- Newsletter core schema
create extension if not exists pgcrypto;

create table if not exists newsletter_subscribers (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  first_name text,
  last_name text,
  status text not null default 'pending',
  consent_source text,
  consent_evidence text,
  consent_ip text,
  opted_in_at timestamptz,
  confirmed_at timestamptz,
  unsubscribed_at timestamptz,
  suppress_reason text,
  is_suppressed boolean not null default false,
  source_lead_id uuid references leads(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (status in ('pending','active','unsubscribed','bounced','complained','suppressed'))
);

create index if not exists newsletter_subscribers_status_idx on newsletter_subscribers(status);
create index if not exists newsletter_subscribers_suppressed_idx on newsletter_subscribers(is_suppressed);

create table if not exists newsletter_preferences (
  id uuid primary key default gen_random_uuid(),
  subscriber_id uuid not null references newsletter_subscribers(id) on delete cascade,
  category text not null,
  is_enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (subscriber_id, category)
);

create index if not exists newsletter_preferences_subscriber_idx on newsletter_preferences(subscriber_id);

create table if not exists newsletter_issues (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  slug text unique,
  subject text not null,
  body_html text not null,
  status text not null default 'draft',
  audience_filters jsonb not null default '{}'::jsonb,
  recurring_enabled boolean not null default false,
  recurring_rrule text,
  recurring_next_run_at timestamptz,
  scheduled_at timestamptz,
  published_at timestamptz,
  paused_at timestamptz,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (status in ('draft','scheduled','published','paused','completed'))
);

create table if not exists newsletter_send_jobs (
  id uuid primary key default gen_random_uuid(),
  issue_id uuid not null references newsletter_issues(id) on delete cascade,
  subscriber_id uuid not null references newsletter_subscribers(id) on delete cascade,
  status text not null default 'queued',
  scheduled_for timestamptz,
  attempts int not null default 0,
  last_error text,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (issue_id, subscriber_id),
  check (status in ('queued','processing','sent','failed','suppressed','skipped'))
);

create index if not exists newsletter_send_jobs_status_idx on newsletter_send_jobs(status);
create index if not exists newsletter_send_jobs_issue_idx on newsletter_send_jobs(issue_id);
create index if not exists newsletter_send_jobs_scheduled_idx on newsletter_send_jobs(scheduled_for);

create table if not exists newsletter_send_logs (
  id uuid primary key default gen_random_uuid(),
  issue_id uuid not null references newsletter_issues(id) on delete cascade,
  subscriber_id uuid not null references newsletter_subscribers(id) on delete cascade,
  job_id uuid references newsletter_send_jobs(id) on delete set null,
  inbox_id uuid references inboxes(id) on delete set null,
  status text not null,
  provider_message_id text,
  error text,
  created_at timestamptz not null default now()
);

create index if not exists newsletter_send_logs_issue_idx on newsletter_send_logs(issue_id);

create table if not exists unsubscribe_tokens (
  id uuid primary key default gen_random_uuid(),
  subscriber_id uuid not null references newsletter_subscribers(id) on delete cascade,
  purpose text not null,
  token_hash text not null unique,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  check (purpose in ('confirm','unsubscribe','preferences'))
);

create index if not exists unsubscribe_tokens_subscriber_idx on unsubscribe_tokens(subscriber_id);
create index if not exists unsubscribe_tokens_purpose_idx on unsubscribe_tokens(purpose);

alter table sending_limits_config
  add column if not exists newsletter_hourly_cap int not null default 50;

create or replace function set_timestamp_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_newsletter_subscribers_updated_at on newsletter_subscribers;
create trigger trg_newsletter_subscribers_updated_at
before update on newsletter_subscribers
for each row execute function set_timestamp_updated_at();

drop trigger if exists trg_newsletter_preferences_updated_at on newsletter_preferences;
create trigger trg_newsletter_preferences_updated_at
before update on newsletter_preferences
for each row execute function set_timestamp_updated_at();

drop trigger if exists trg_newsletter_issues_updated_at on newsletter_issues;
create trigger trg_newsletter_issues_updated_at
before update on newsletter_issues
for each row execute function set_timestamp_updated_at();

drop trigger if exists trg_newsletter_send_jobs_updated_at on newsletter_send_jobs;
create trigger trg_newsletter_send_jobs_updated_at
before update on newsletter_send_jobs
for each row execute function set_timestamp_updated_at();
