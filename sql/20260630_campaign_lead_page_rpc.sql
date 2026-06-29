create or replace function public.dashboard_campaign_lead_page(
  p_campaign_id uuid,
  p_scope text default 'available',
  p_query text default null,
  p_folder_id uuid default null,
  p_offset integer default 0,
  p_limit integer default 50
)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  with target_campaign as (
    select id, operator_id
    from public.campaigns
    where id = p_campaign_id
  ),
  filtered as (
    select l.*
    from public.leads l
    join target_campaign c on c.operator_id = l.operator_id
    where (p_folder_id is null or l.folder_id = p_folder_id)
      and (
        nullif(trim(coalesce(p_query, '')), '') is null
        or l.email ilike '%' || trim(p_query) || '%'
        or l.first_name ilike '%' || trim(p_query) || '%'
        or l.company ilike '%' || trim(p_query) || '%'
      )
      and (
        (p_scope = 'attached' and exists (
          select 1 from public.campaign_leads cl
          where cl.campaign_id = p_campaign_id and cl.lead_id = l.id
        ))
        or
        (p_scope <> 'attached' and not exists (
          select 1 from public.campaign_leads cl
          where cl.campaign_id = p_campaign_id and cl.lead_id = l.id
        ))
      )
  ),
  page_rows as (
    select * from filtered
    order by created_at desc nulls last, id
    offset greatest(p_offset, 0)
    limit greatest(1, least(p_limit, 100))
  )
  select jsonb_build_object(
    'rows', coalesce((select jsonb_agg(to_jsonb(page_rows)) from page_rows), '[]'::jsonb),
    'total', (select count(*) from filtered)
  );
$$;

grant execute on function public.dashboard_campaign_lead_page(uuid, text, text, uuid, integer, integer)
  to authenticated, service_role;

create or replace function public.dashboard_campaign_progress_summary(p_campaign_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  with progress as (
    select
      coalesce(status, 'pending') as status,
      greatest(coalesce(current_step, 1), 1) as current_step,
      count(*)::bigint as count
    from public.campaign_leads
    where campaign_id = p_campaign_id
    group by coalesce(status, 'pending'), greatest(coalesce(current_step, 1), 1)
  ),
  lead_mix as (
    select
      count(*) filter (where l.email_eligibility = 'eligible' and coalesce(l.is_suppressed, false) = false)::bigint as eligible,
      count(*) filter (where l.email_eligibility = 'risky' and coalesce(l.is_suppressed, false) = false)::bigint as risky,
      count(*) filter (where coalesce(l.is_suppressed, false) = true)::bigint as suppressed
    from public.campaign_leads cl
    join public.leads l on l.id = cl.lead_id
    where cl.campaign_id = p_campaign_id
  )
  select jsonb_build_object(
    'total', (select coalesce(sum(count), 0) from progress),
    'groups', coalesce((select jsonb_agg(to_jsonb(progress) order by current_step, status) from progress), '[]'::jsonb),
    'lead_mix', coalesce((select to_jsonb(lead_mix) from lead_mix), '{"eligible":0,"risky":0,"suppressed":0}'::jsonb)
  );
$$;

grant execute on function public.dashboard_campaign_progress_summary(uuid)
  to authenticated, service_role;
