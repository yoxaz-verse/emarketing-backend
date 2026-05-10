ALTER TABLE public.sending_limits_config
  ADD COLUMN IF NOT EXISTS schedule_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS schedule_timezone text NOT NULL DEFAULT 'Asia/Kolkata',
  ADD COLUMN IF NOT EXISTS allowed_weekdays jsonb NOT NULL DEFAULT '[0,1,2,3,4,5,6]'::jsonb,
  ADD COLUMN IF NOT EXISTS send_window_start text NOT NULL DEFAULT '00:00',
  ADD COLUMN IF NOT EXISTS send_window_end text NOT NULL DEFAULT '23:59';
