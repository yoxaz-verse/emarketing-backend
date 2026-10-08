-- READ ONLY. This file intentionally performs no DROP, ALTER, UPDATE, or DELETE.
-- Run after the current migrations and review the results before authoring any
-- destructive cleanup migration.

-- Active backend code references these tables, but they were absent from the
-- supplied production schema export.
with expected(table_name) as (
  values
    ('agent_chat_requests'),
    ('agent_context_documents'),
    ('agent_memories'),
    ('agent_messages'),
    ('blog_platform_connectors'),
    ('blog_platform_publish_jobs'),
    ('blog_platform_publish_requests'),
    ('campaign_merge_mappings'),
    ('campaign_voice_agents'),
    ('daily_send_stats'),
    ('inbox_analytics'),
    ('inquiry_coding_events'),
    ('inquiry_quote_events'),
    ('lead_sequences'),
    ('password_reset_tokens'),
    ('sequence_analytics'),
    ('sequence_run_steps'),
    ('sequence_runs'),
    ('voice_agents')
)
select table_name, to_regclass('public.' || table_name) is not null as present
from expected
order by table_name;

-- Tables with no direct application reference. A non-zero row count or a
-- dependency means the object must not be removed without a dedicated review.
select 'agent_integrations_archive' as object_name, count(*) as row_count from public.agent_integrations_archive
union all select 'agent_task_integration_links_archive', count(*) from public.agent_task_integration_links_archive
union all select 'campaign_channels', count(*) from public.campaign_channels
union all select 'lead_folder_memberships', count(*) from public.lead_folder_memberships
union all select 'voice_events', count(*) from public.voice_events
union all select 'warmup_schedule', count(*) from public.warmup_schedule
order by object_name;

-- Columns with no runtime source reference found in the 2026-10-08 audit.
-- These counts are evidence only, not authorization to drop a column.
select
  count(*) as campaign_lead_rows,
  count(*) filter (where locked_at is not null) as locked_at_populated
from public.campaign_leads;

select
  count(*) as voice_call_rows,
  count(*) filter (where ended_at is not null) as ended_at_populated
from public.voice_calls;

-- Foreign keys and views depending on the candidate tables.
select
  c.conname as dependency_name,
  c.conrelid::regclass::text as dependent_table,
  c.confrelid::regclass::text as referenced_table
from pg_constraint c
where c.contype = 'f'
  and (
    c.conrelid in (
      'public.agent_integrations_archive'::regclass,
      'public.agent_task_integration_links_archive'::regclass,
      'public.campaign_channels'::regclass,
      'public.lead_folder_memberships'::regclass,
      'public.voice_events'::regclass,
      'public.warmup_schedule'::regclass
    )
    or c.confrelid in (
      'public.agent_integrations_archive'::regclass,
      'public.agent_task_integration_links_archive'::regclass,
      'public.campaign_channels'::regclass,
      'public.lead_folder_memberships'::regclass,
      'public.voice_events'::regclass,
      'public.warmup_schedule'::regclass
    )
  )
order by dependent_table, dependency_name;
