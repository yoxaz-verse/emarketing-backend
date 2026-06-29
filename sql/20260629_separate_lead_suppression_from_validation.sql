-- Keep mailbox validation independent from recipient consent/suppression.
alter table public.leads
  add column if not exists is_suppressed boolean not null default false,
  add column if not exists suppression_reason text,
  add column if not exists suppressed_at timestamptz;

create index if not exists leads_is_suppressed_idx
  on public.leads (is_suppressed)
  where is_suppressed = true;

-- Preserve every existing campaign unsubscribe as a global suppression. The
-- previous mailbox result was overwritten, so queue a fresh validation rather
-- than guessing that the address is still valid.
update public.leads
set
  is_suppressed = true,
  suppression_reason = coalesce(suppression_reason, 'user_unsubscribed_campaign'),
  suppressed_at = coalesce(suppressed_at, now()),
  email_eligibility = 'pending',
  email_eligibility_reason = null,
  email_checked_at = null,
  eligibility_processing = false,
  permanently_failed = false,
  retry_count = 0
where email_eligibility_reason = 'user_unsubscribed_campaign';

comment on column public.leads.is_suppressed is
  'Global cold-email consent suppression. Validation must never clear this flag.';
comment on column public.leads.suppression_reason is
  'Stable reason for global suppression, independent of mailbox validation.';

create or replace function public.remove_lead_suppression_with_reconsent(p_lead_id uuid)
returns table (requeued_count bigint)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_eligibility text;
  v_is_suppressed boolean;
  v_requeued_count bigint := 0;
begin
  select lower(coalesce(l.email_eligibility, '')), l.is_suppressed
    into v_eligibility, v_is_suppressed
  from public.leads l
  where l.id = p_lead_id
  for update;

  if not found then
    raise exception 'Lead not found';
  end if;

  if not v_is_suppressed then
    return query select 0::bigint;
    return;
  end if;

  if v_eligibility not in ('eligible', 'risky') then
    raise exception 'Validate this email successfully before removing suppression.';
  end if;

  update public.leads
  set is_suppressed = false,
      suppression_reason = null,
      suppressed_at = null
  where id = p_lead_id;

  update public.campaign_leads
  set status = 'queued',
      status_reason = 'explicit_reconsent_requeued',
      processing_at = null,
      execution_id = null
  where lead_id = p_lead_id
    and status = 'paused'
    and status_reason = 'user_unsubscribed_campaign';
  get diagnostics v_requeued_count = row_count;

  return query select v_requeued_count;
end;
$$;

revoke all on function public.remove_lead_suppression_with_reconsent(uuid) from public;
grant execute on function public.remove_lead_suppression_with_reconsent(uuid) to service_role;
