-- Preserve the legacy meta connector for scheduled jobs created before the split.
alter table public.social_oauth_states add column if not exists requested_platform text;
comment on column public.social_oauth_states.requested_platform is
  'Original connector selected by the user; Facebook and Instagram share platform_code=meta.';
insert into public.social_connectors
  (code, name, status, auth_type, can_schedule, can_publish, credentials_active, deep_link_url, metadata)
values
  ('facebook', 'Facebook', 'manual_assisted', 'oauth2', true, true, false, 'https://business.facebook.com/', '{}'::jsonb),
  ('instagram', 'Instagram', 'manual_assisted', 'oauth2', true, true, false, 'https://www.instagram.com/', '{}'::jsonb)
on conflict (code) do update set
  name = excluded.name,
  can_schedule = true,
  can_publish = true,
  updated_at = now();

-- PostgREST can otherwise continue serving the pre-migration column cache briefly.
notify pgrst, 'reload schema';
