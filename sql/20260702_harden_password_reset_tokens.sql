alter table if exists public.password_reset_tokens
  add column if not exists attempt_count integer not null default 0,
  add column if not exists reset_token_hash text,
  add column if not exists verified_at timestamptz,
  add column if not exists consumed_at timestamptz;

create index if not exists password_reset_tokens_active_lookup_idx
  on public.password_reset_tokens (email, expires_at desc)
  where consumed_at is null;

create unique index if not exists password_reset_tokens_reset_token_hash_idx
  on public.password_reset_tokens (reset_token_hash)
  where reset_token_hash is not null;
