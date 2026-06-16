ALTER TABLE public.system_events
ADD COLUMN IF NOT EXISTS meta JSONB NULL;

CREATE INDEX IF NOT EXISTS idx_system_events_meta_gin
ON public.system_events
USING GIN (meta);
