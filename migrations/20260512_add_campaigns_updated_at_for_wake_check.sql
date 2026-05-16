-- Add updated_at support for campaign wake-check versioning.
alter table public.campaigns
  add column if not exists updated_at timestamptz;

alter table public.campaigns
  alter column updated_at set default now();

-- Backfill existing rows. Prefer created_at when available, else now().
do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'campaigns'
      and column_name = 'created_at'
  ) then
    execute 'update public.campaigns set updated_at = coalesce(updated_at, created_at, now()) where updated_at is null';
  else
    execute 'update public.campaigns set updated_at = coalesce(updated_at, now()) where updated_at is null';
  end if;
end;
$$;

alter table public.campaigns
  alter column updated_at set not null;

create or replace function public.set_timestamp_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_campaigns_updated_at on public.campaigns;
create trigger trg_campaigns_updated_at
before update on public.campaigns
for each row execute function public.set_timestamp_updated_at();

create index if not exists campaigns_updated_at_desc_idx
  on public.campaigns (updated_at desc);
