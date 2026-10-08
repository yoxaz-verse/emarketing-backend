begin;

create table if not exists public.campaign_merge_mappings (
  campaign_id uuid not null references public.campaigns(id) on delete cascade,
  placeholder_key text not null,
  placeholder_label text not null,
  source_type text not null check (source_type in ('lead_field', 'fixed_text')),
  lead_field text null,
  fixed_value text null,
  required boolean not null default true,
  reviewed_signature text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (campaign_id, placeholder_key),
  constraint campaign_merge_mapping_source_value_check check (
    (source_type = 'lead_field' and lead_field is not null and fixed_value is null)
    or
    (source_type = 'fixed_text' and fixed_value is not null and lead_field is null)
  )
);

create index if not exists campaign_merge_mappings_campaign_id_idx
  on public.campaign_merge_mappings(campaign_id);

alter table public.campaign_merge_mappings enable row level security;

notify pgrst, 'reload schema';
commit;
