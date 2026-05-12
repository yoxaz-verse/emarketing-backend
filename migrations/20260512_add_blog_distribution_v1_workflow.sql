create table if not exists public.blog_sources (
  id uuid primary key default gen_random_uuid(),
  provider_type text not null check (provider_type in ('rss','api')),
  publisher_name text not null,
  source_name text not null,
  feed_url text not null unique,
  region text,
  categories text[] not null default '{}'::text[],
  trust_score numeric(4,2) not null default 0.60,
  active boolean not null default true,
  polling_interval_minutes integer not null default 60 check (polling_interval_minutes >= 5),
  metadata jsonb not null default '{}'::jsonb,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_blog_sources_active on public.blog_sources(active);

create table if not exists public.blog_ingestion_items (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references public.blog_sources(id) on delete cascade,
  canonical_url text not null,
  dedupe_hash text not null unique,
  external_id text,
  title text not null,
  snippet text,
  content_text text not null,
  published_at timestamptz,
  language text not null default 'en',
  source_snapshot jsonb not null default '{}'::jsonb,
  moderation_flags jsonb not null default '{}'::jsonb,
  ingestion_status text not null default 'ingested' check (ingestion_status in ('ingested','drafted','pending_review','approved','scheduled','published','rejected')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_blog_ingestion_items_source_id on public.blog_ingestion_items(source_id);
create index if not exists idx_blog_ingestion_items_status on public.blog_ingestion_items(ingestion_status);

alter table public.blogs
  add column if not exists status text not null default 'pending_review' check (status in ('ingested','drafted','pending_review','approved','scheduled','published','rejected')),
  add column if not exists community_ids text[] not null default '{}'::text[],
  add column if not exists source_snapshot jsonb not null default '{}'::jsonb,
  add column if not exists generated_content jsonb not null default '{}'::jsonb,
  add column if not exists moderation_flags jsonb not null default '{}'::jsonb,
  add column if not exists approved_by text,
  add column if not exists approved_at timestamptz;

create index if not exists idx_blogs_status on public.blogs(status);

create table if not exists public.blog_review_events (
  id uuid primary key default gen_random_uuid(),
  blog_id uuid not null references public.blogs(id) on delete cascade,
  action text not null check (action in ('approve','reject','edit')),
  actor_id text,
  notes text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_blog_review_events_blog_id on public.blog_review_events(blog_id);

create table if not exists public.community_blog_posts (
  id uuid primary key default gen_random_uuid(),
  community_id text not null,
  blog_id uuid not null references public.blogs(id) on delete cascade,
  source_preference_tags text[] not null default '{}'::text[],
  status text not null default 'approved' check (status in ('approved','published','archived')),
  published_at timestamptz,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (community_id, blog_id)
);

create index if not exists idx_community_blog_posts_community on public.community_blog_posts(community_id);
create index if not exists idx_community_blog_posts_status on public.community_blog_posts(status);
