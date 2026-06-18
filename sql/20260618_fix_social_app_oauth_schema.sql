-- Fix social app OAuth schema support for global defaults and Supabase upserts.
-- Safe to re-run.

CREATE TABLE IF NOT EXISTS public.social_global_oauth_apps (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  platform_code text NOT NULL CHECK (
    platform_code = ANY (ARRAY[
      'linkedin'::text,
      'meta'::text,
      'reddit'::text,
      'telegram'::text,
      'whatsapp'::text
    ])
  ),
  client_id text,
  client_secret_encrypted text NOT NULL,
  redirect_uri text,
  scopes text[] NOT NULL DEFAULT '{}'::text[],
  active boolean NOT NULL DEFAULT true,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT social_global_oauth_apps_pkey PRIMARY KEY (id),
  CONSTRAINT social_global_oauth_apps_platform_code_key UNIQUE (platform_code)
);

CREATE UNIQUE INDEX IF NOT EXISTS social_operator_oauth_apps_operator_platform_uidx
  ON public.social_operator_oauth_apps (operator_id, platform_code);

CREATE UNIQUE INDEX IF NOT EXISTS social_oauth_connections_platform_user_operator_uidx
  ON public.social_oauth_connections (platform_code, user_id, operator_id);

DO $$
DECLARE
  constraint_name text;
BEGIN
  FOR constraint_name IN
    SELECT c.conname
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'social_connectors'
      AND c.contype = 'c'
      AND pg_get_constraintdef(c.oid) ILIKE '%status%'
  LOOP
    EXECUTE format('ALTER TABLE public.social_connectors DROP CONSTRAINT %I', constraint_name);
  END LOOP;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'social_connectors'
      AND c.conname = 'social_connectors_status_check'
  ) THEN
    ALTER TABLE public.social_connectors
      ADD CONSTRAINT social_connectors_status_check
      CHECK (status = ANY (ARRAY['manual_assisted'::text, 'api_enabled'::text]));
  END IF;
END $$;

DO $$
DECLARE
  constraint_name text;
BEGIN
  FOR constraint_name IN
    SELECT c.conname
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'social_connectors'
      AND c.contype = 'c'
      AND pg_get_constraintdef(c.oid) ILIKE '%auth_type%'
  LOOP
    EXECUTE format('ALTER TABLE public.social_connectors DROP CONSTRAINT %I', constraint_name);
  END LOOP;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'social_connectors'
      AND c.conname = 'social_connectors_auth_type_check'
  ) THEN
    ALTER TABLE public.social_connectors
      ADD CONSTRAINT social_connectors_auth_type_check
      CHECK (auth_type = ANY (ARRAY['none'::text, 'oauth2'::text]));
  END IF;
END $$;
