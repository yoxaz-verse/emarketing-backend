CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.social_publish_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key text UNIQUE NOT NULL,
  post_input jsonb NOT NULL DEFAULT '{}'::jsonb,
  targets text[] NOT NULL DEFAULT '{}'::text[],
  operator_id uuid NULL,
  created_by uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.social_publish_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES public.social_publish_requests(id) ON DELETE CASCADE,
  platform_code text NOT NULL,
  status text NOT NULL DEFAULT 'draft_created',
  phase text NOT NULL DEFAULT 'DRAFT_CREATE',
  post_input jsonb NOT NULL DEFAULT '{}'::jsonb,
  scheduled_at timestamptz NULL,
  timeline jsonb NOT NULL DEFAULT '[]'::jsonb,
  manual_task jsonb NULL,
  external_post_id text NULL,
  external_post_url text NULL,
  validation_errors jsonb NULL,
  error_code text NULL,
  error_message text NULL,
  provider_error_code text NULL,
  provider_error_message text NULL,
  attempts integer NOT NULL DEFAULT 0,
  operator_id uuid NULL,
  created_by uuid NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.social_publish_requests
  ADD COLUMN IF NOT EXISTS operator_id uuid NULL,
  ADD COLUMN IF NOT EXISTS created_by uuid NULL,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE public.social_publish_jobs
  ADD COLUMN IF NOT EXISTS operator_id uuid NULL,
  ADD COLUMN IF NOT EXISTS scheduled_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'draft_created',
  ADD COLUMN IF NOT EXISTS phase text NOT NULL DEFAULT 'DRAFT_CREATE',
  ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS created_by uuid NULL,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

UPDATE public.social_publish_jobs j
SET operator_id = r.operator_id
FROM public.social_publish_requests r
WHERE j.request_id = r.id
  AND j.operator_id IS NULL
  AND r.operator_id IS NOT NULL;

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
      AND t.relname = 'social_publish_jobs'
      AND c.contype = 'c'
      AND pg_get_constraintdef(c.oid) ILIKE '%status%'
  LOOP
    EXECUTE format('ALTER TABLE public.social_publish_jobs DROP CONSTRAINT %I', constraint_name);
  END LOOP;
END $$;

ALTER TABLE public.social_publish_jobs
  ADD CONSTRAINT social_publish_jobs_status_check
  CHECK (status IN (
    'scheduled',
    'draft_created',
    'validated',
    'approval_pending',
    'manual_action_required',
    'published',
    'failed'
  ));

CREATE INDEX IF NOT EXISTS social_publish_jobs_due_idx
  ON public.social_publish_jobs (status, scheduled_at)
  WHERE scheduled_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS social_publish_jobs_operator_idx
  ON public.social_publish_jobs (operator_id, scheduled_at DESC);

CREATE INDEX IF NOT EXISTS social_publish_jobs_request_idx
  ON public.social_publish_jobs (request_id);
