-- Normalize and enforce per-operator email uniqueness for leads.

with ranked as (
  select
    id,
    row_number() over (
      partition by operator_id, lower(trim(email))
      order by created_at asc, id asc
    ) as rn
  from public.leads
  where operator_id is not null
    and email is not null
    and trim(email) <> ''
)
delete from public.leads l
using ranked r
where l.id = r.id
  and r.rn > 1;

update public.leads
set email = lower(trim(email))
where email is not null
  and email <> lower(trim(email));

create unique index if not exists ux_leads_operator_normalized_email
on public.leads (operator_id, lower(trim(email)))
where operator_id is not null
  and email is not null
  and trim(email) <> '';
