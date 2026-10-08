begin;

create table if not exists public.reply_capture_cursors (
  inbox_id text not null,
  mailbox_name text not null default 'INBOX',
  host text not null,
  uid_validity text,
  last_uid bigint not null default 0 check (last_uid >= 0),
  last_success_at timestamptz,
  last_error_at timestamptz,
  last_error_code text,
  last_error_message text,
  updated_at timestamptz not null default now(),
  primary key (inbox_id, mailbox_name)
);

alter table public.reply_ingest_events
  add column if not exists processed_at timestamptz;

create table if not exists public.reply_capture_reset_audit (
  reset_key text primary key,
  executed_at timestamptz not null default now(),
  counts jsonb not null default '{}'::jsonb
);

alter table public.reply_capture_cursors enable row level security;
alter table public.reply_capture_reset_audit enable row level security;
revoke all on public.reply_capture_cursors, public.reply_capture_reset_audit from anon, authenticated;
grant all on public.reply_capture_cursors, public.reply_capture_reset_audit to service_role;

do $$
declare
  v_reset_key constant text := 'reply-capture-clean-rebuild-2026-10-09';
  v_reply_ids text[];
  v_conversation_ids uuid[];
  v_counts jsonb := '{}'::jsonb;
  v_count bigint;
begin
  insert into public.reply_capture_reset_audit(reset_key)
  values (v_reset_key)
  on conflict do nothing;

  if not found then
    raise notice 'Reply reset % was already applied; skipping destructive work.', v_reset_key;
    return;
  end if;

  select coalesce(array_agg(id::text), array[]::text[])
    into v_reply_ids
    from public.reply_ingest_events;

  if to_regclass('public.communication_messages') is not null then
    select coalesce(array_agg(distinct conversation_id), array[]::uuid[])
      into v_conversation_ids
      from public.communication_messages
      where source_key in (
        select 'reply_ingest_events:' || reply_id from unnest(v_reply_ids) as reply_id
      );

    delete from public.communication_messages
      where source_key in (
        select 'reply_ingest_events:' || reply_id from unnest(v_reply_ids) as reply_id
      );
    get diagnostics v_count = row_count;
    v_counts := v_counts || jsonb_build_object('communication_messages', v_count);

    delete from public.communication_items i
      where i.id = any(v_conversation_ids)
        and not exists (
          select 1 from public.communication_messages m where m.conversation_id = i.id
        );
    get diagnostics v_count = row_count;
    v_counts := v_counts || jsonb_build_object('orphaned_communication_items', v_count);
  end if;

  if to_regclass('public.communication_queue') is not null then
    delete from public.communication_queue where source_table = 'reply_ingest_events';
    get diagnostics v_count = row_count;
    v_counts := v_counts || jsonb_build_object('communication_queue', v_count);
  end if;

  delete from public.email_tracking_events where event_type = 'reply';
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('email_tracking_events', v_count);

  delete from public.system_events
    where type in ('LEAD_REPLIED', 'UNMATCHED_REPLY_RECEIVED', 'UNMATCHED_REPLY_MAPPED');
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('system_events', v_count);

  update public.leads
    set status = 'pending',
        replied_at = null,
        reply_message = null,
        interest_status = null,
        interest_note = null,
        interest_reviewed_at = null,
        interest_reviewed_by = null
    where status = 'replied';
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('reactivated_leads', v_count);

  update public.campaign_leads
    set status = 'completed', status_reason = 'reply_history_reset'
    where status = 'replied';
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('completed_campaign_leads', v_count);

  delete from public.reply_ingest_events;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('reply_ingest_events', v_count);

  delete from public.reply_capture_cursors;
  get diagnostics v_count = row_count;
  v_counts := v_counts || jsonb_build_object('reply_capture_cursors', v_count);

  update public.reply_capture_reset_audit
    set counts = v_counts, executed_at = now()
    where reset_key = v_reset_key;

  raise notice 'Reply capture reset complete: %', v_counts;
end
$$;

notify pgrst, 'reload schema';
commit;

select reset_key, executed_at, counts
from public.reply_capture_reset_audit
where reset_key = 'reply-capture-clean-rebuild-2026-10-09';
