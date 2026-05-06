-- Hotfix: normalize legacy lead validation lifecycle fields
-- Safe to run multiple times.

ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS email_eligibility TEXT;

ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS eligibility_processing BOOLEAN;

ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS retry_count INTEGER;

ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS permanently_failed BOOLEAN;

UPDATE public.leads
SET email_eligibility = 'pending'
WHERE email_eligibility IS NULL;

UPDATE public.leads
SET eligibility_processing = false
WHERE eligibility_processing IS NULL;

UPDATE public.leads
SET retry_count = 0
WHERE retry_count IS NULL;

UPDATE public.leads
SET permanently_failed = false
WHERE permanently_failed IS NULL;

ALTER TABLE public.leads
  ALTER COLUMN eligibility_processing SET DEFAULT false;

ALTER TABLE public.leads
  ALTER COLUMN retry_count SET DEFAULT 0;

ALTER TABLE public.leads
  ALTER COLUMN permanently_failed SET DEFAULT false;
