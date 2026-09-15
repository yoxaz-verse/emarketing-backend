-- Required by the publish worker when it persists provider success/failure.
alter table public.social_publish_jobs
  add column if not exists provider_error_code text,
  add column if not exists provider_error_message text;

create index if not exists social_publish_jobs_due_idx
  on public.social_publish_jobs (scheduled_at, status)
  where status = 'scheduled';
