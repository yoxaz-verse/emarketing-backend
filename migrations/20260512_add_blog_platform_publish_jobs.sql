create table if not exists public.blog_platform_connectors (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code in ('medium')),
  name text not null,
  status text not null check (status in ('manual_assisted')),
  auth_type text not null check (auth_type in ('none')),
  can_schedule boolean not null default true,
  can_publish boolean not null default true,
  credentials_active boolean not null default true,
  deep_link_url text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.blog_platform_publish_requests (
  id uuid primary key default gen_random_uuid(),
  idempotency_key text not null unique,
  blog_id uuid not null references public.blogs(id) on delete cascade,
  scheduled_at timestamptz,
  timezone text not null default 'Asia/Kolkata',
  targets text[] not null,
  social_request_id uuid references public.social_publish_requests(id) on delete set null,
  created_by text,
  operator_id text,
  created_at timestamptz not null default now()
);

create table if not exists public.blog_platform_publish_jobs (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.blog_platform_publish_requests(id) on delete cascade,
  platform_code text not null references public.blog_platform_connectors(code),
  status text not null,
  phase text not null,
  post_input jsonb not null,
  scheduled_at timestamptz,
  validation_errors jsonb,
  external_post_id text,
  external_post_url text,
  manual_task jsonb,
  error_code text,
  error_message text,
  timeline jsonb not null default '[]'::jsonb,
  attempts integer not null default 0,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_blog_platform_publish_jobs_request_id on public.blog_platform_publish_jobs(request_id);
create index if not exists idx_blog_platform_publish_jobs_status on public.blog_platform_publish_jobs(status);

insert into public.blog_platform_connectors (
  code, name, status, auth_type, can_schedule, can_publish, credentials_active, deep_link_url, metadata
) values
  ('medium', 'Medium', 'manual_assisted', 'none', true, true, true, 'https://medium.com/new-story', '{"region":"global"}'::jsonb)
on conflict (code) do update set
  name = excluded.name,
  status = excluded.status,
  auth_type = excluded.auth_type,
  can_schedule = excluded.can_schedule,
  can_publish = excluded.can_publish,
  credentials_active = excluded.credentials_active,
  deep_link_url = excluded.deep_link_url,
  metadata = excluded.metadata,
  updated_at = now();
