create table if not exists public.social_connectors (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code in ('meta','linkedin','reddit','telegram','whatsapp')),
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

create table if not exists public.social_publish_requests (
  id uuid primary key default gen_random_uuid(),
  idempotency_key text not null unique,
  post_input jsonb not null,
  targets text[] not null,
  operator_id text,
  created_by text,
  created_at timestamptz not null default now()
);

create table if not exists public.social_publish_jobs (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.social_publish_requests(id) on delete cascade,
  platform_code text not null references public.social_connectors(code),
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

create index if not exists idx_social_publish_jobs_request_id on public.social_publish_jobs(request_id);
create index if not exists idx_social_publish_jobs_status on public.social_publish_jobs(status);

create table if not exists public.blogs (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  body text not null,
  source_type text not null default 'internal' check (source_type in ('internal','url','rss')),
  source_url text,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.blog_distribution_jobs (
  id uuid primary key default gen_random_uuid(),
  blog_id uuid not null references public.blogs(id) on delete cascade,
  channels text[] not null,
  scheduled_at timestamptz,
  timezone text not null default 'Asia/Kolkata',
  social_request_id uuid references public.social_publish_requests(id) on delete set null,
  status text not null default 'queued' check (status in ('queued','processing','completed','failed')),
  created_by text,
  operator_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_blog_distribution_jobs_blog_id on public.blog_distribution_jobs(blog_id);

insert into public.social_connectors (
  code, name, status, auth_type, can_schedule, can_publish, credentials_active, deep_link_url, metadata
) values
  ('meta', 'Meta (Facebook/Instagram)', 'manual_assisted', 'none', true, true, true, 'https://business.facebook.com/', '{"region":"india"}'::jsonb),
  ('linkedin', 'LinkedIn', 'manual_assisted', 'none', true, true, true, 'https://www.linkedin.com/feed/', '{"region":"india"}'::jsonb),
  ('reddit', 'Reddit', 'manual_assisted', 'none', true, true, true, 'https://www.reddit.com/submit', '{"region":"india"}'::jsonb),
  ('telegram', 'Telegram', 'manual_assisted', 'none', true, true, true, 'https://web.telegram.org/', '{"region":"india"}'::jsonb),
  ('whatsapp', 'WhatsApp', 'manual_assisted', 'none', true, true, true, 'https://web.whatsapp.com/', '{"region":"india"}'::jsonb)
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
