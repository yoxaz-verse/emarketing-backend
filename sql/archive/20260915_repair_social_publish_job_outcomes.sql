-- Archived 2026-10-08 after the production schema export confirmed both
-- provider outcome columns. The due-job index remains covered by the current
-- verification/repair migration.
alter table public.social_publish_jobs
  add column if not exists provider_error_code text,
  add column if not exists provider_error_message text;

create index if not exists social_publish_jobs_due_idx
  on public.social_publish_jobs (scheduled_at, status)
  where status = 'scheduled';
