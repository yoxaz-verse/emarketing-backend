alter table public.agents
  add column if not exists role_key text,
  add column if not exists memory_policy jsonb not null default '{"strategy":"summary","max_turns":12,"summary_trigger_tokens":8000}'::jsonb;

create unique index if not exists idx_agents_role_key_unique
  on public.agents(role_key)
  where role_key is not null;

create table if not exists public.agent_memories (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  role_key text not null,
  summary text,
  recent_messages jsonb not null default '[]'::jsonb,
  message_count integer not null default 0,
  approx_tokens integer not null default 0,
  last_request_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id, role_key)
);

create index if not exists idx_agent_memories_role_user on public.agent_memories(role_key, user_id);

create table if not exists public.agent_messages (
  id uuid primary key default gen_random_uuid(),
  memory_id uuid not null references public.agent_memories(id) on delete cascade,
  request_id text not null,
  role text not null check (role in ('user', 'assistant', 'system')),
  content text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_agent_messages_memory_created on public.agent_messages(memory_id, created_at desc);
create unique index if not exists idx_agent_messages_memory_request_role_unique
  on public.agent_messages(memory_id, request_id, role);

create table if not exists public.agent_chat_requests (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  role_key text not null,
  request_id text not null,
  status text not null default 'completed',
  response_text text,
  response_json jsonb,
  created_at timestamptz not null default now(),
  unique(user_id, role_key, request_id)
);

create index if not exists idx_agent_chat_requests_lookup on public.agent_chat_requests(user_id, role_key, request_id);
