-- Normalize inbox emails, remove duplicates (keep oldest), then enforce uniqueness.
-- Strategy: keep the oldest row by created_at (tie-breaker: id), delete newer duplicates.

update inboxes
set email_address = lower(trim(email_address))
where email_address is not null;

with ranked as (
  select
    id,
    email_address,
    row_number() over (
      partition by email_address
      order by created_at asc nulls last, id asc
    ) as rn
  from inboxes
  where email_address is not null
)
delete from inboxes i
using ranked r
where i.id = r.id
  and r.rn > 1;

create unique index if not exists inboxes_email_address_unique_idx
on inboxes (email_address);
