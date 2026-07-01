-- Campaign-level From-name override used by sender settings and email execution.
-- Nullable means the application-wide default sender name remains in effect.
alter table public.campaigns
  add column if not exists sender_display_name text;

comment on column public.campaigns.sender_display_name is
  'Optional campaign-specific display name used in the From header.';
