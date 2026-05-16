create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table if not exists public.agent_integrations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  provider text not null,
  mode text not null,
  status text not null default 'active',
  base_url text,
  fallback_endpoint text,
  auth_type text,
  model text,
  role_key text,
  config jsonb not null default '{}'::jsonb,
  created_by uuid references public.users(id),
  operator_id uuid references public.operators(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.agent_context_documents (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  role_key text not null,
  content text not null,
  active boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid references public.users(id),
  operator_id uuid references public.operators(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.agent_tasks (
  id uuid primary key default gen_random_uuid(),
  integration_id uuid references public.agent_integrations(id),
  role_key text not null,
  task_type text not null,
  input text not null,
  status text not null default 'pending',
  priority integer not null default 5,
  result text,
  structured_outputs jsonb not null default '[]'::jsonb,
  error text,
  metadata jsonb not null default '{}'::jsonb,
  source_entity text,
  source_entity_id uuid,
  created_by uuid references public.users(id),
  operator_id uuid references public.operators(id),
  picked_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint agent_tasks_status_check check (status in ('pending', 'processing', 'completed', 'failed', 'cancelled')),
  constraint agent_tasks_role_key_check check (
    role_key in (
      'content_creator',
      'scraper',
      'image_prompt_creator',
      'email_sequence_creator',
      'lead_enrichment_agent',
      'blog_writer',
      'social_post_creator',
      'warehouse_content_creator',
      'research_agent'
    )
  ),
  constraint agent_tasks_task_type_check check (
    task_type in (
      'content_creation',
      'scraping',
      'image_prompt',
      'email_sequence',
      'lead_enrichment',
      'blog_draft',
      'social_post',
      'warehouse_content',
      'research',
      'newsletter_draft',
      'marketplace_listing'
    )
  )
);

create table if not exists public.agent_task_events (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.agent_tasks(id) on delete cascade,
  event_type text not null,
  message text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_agent_tasks_status_priority_created
  on public.agent_tasks(status, priority, created_at);
create index if not exists idx_agent_tasks_role_key
  on public.agent_tasks(role_key);
create index if not exists idx_agent_tasks_task_type
  on public.agent_tasks(task_type);
create index if not exists idx_agent_tasks_operator_id
  on public.agent_tasks(operator_id);
create index if not exists idx_agent_tasks_created_by
  on public.agent_tasks(created_by);
create index if not exists idx_agent_task_events_task_created
  on public.agent_task_events(task_id, created_at);

create index if not exists idx_agent_integrations_provider_mode
  on public.agent_integrations(provider, mode);
create index if not exists idx_agent_context_documents_role_active
  on public.agent_context_documents(role_key, active);

drop trigger if exists trg_agent_integrations_updated_at on public.agent_integrations;
create trigger trg_agent_integrations_updated_at
before update on public.agent_integrations
for each row execute function public.set_updated_at();

drop trigger if exists trg_agent_context_documents_updated_at on public.agent_context_documents;
create trigger trg_agent_context_documents_updated_at
before update on public.agent_context_documents
for each row execute function public.set_updated_at();

drop trigger if exists trg_agent_tasks_updated_at on public.agent_tasks;
create trigger trg_agent_tasks_updated_at
before update on public.agent_tasks
for each row execute function public.set_updated_at();
