-- Persist global sending-limits configuration used by admin/sending-limits.
CREATE TABLE IF NOT EXISTS public.sending_limits_config (
  id boolean PRIMARY KEY DEFAULT true CHECK (id = true),
  min_inbox_health_score integer NOT NULL DEFAULT 60 CHECK (min_inbox_health_score BETWEEN 0 AND 100),
  min_domain_health_score integer NOT NULL DEFAULT 60 CHECK (min_domain_health_score BETWEEN 0 AND 100),
  warmup_advance_min_health_score integer NOT NULL DEFAULT 70 CHECK (warmup_advance_min_health_score BETWEEN 0 AND 100),
  warmup_advance_max_consecutive_failures integer NOT NULL DEFAULT 2 CHECK (warmup_advance_max_consecutive_failures >= 0),
  risky_daily_percent_limit integer NOT NULL DEFAULT 20 CHECK (risky_daily_percent_limit BETWEEN 0 AND 100),
  warmup_steps jsonb NOT NULL DEFAULT '[{"day":1,"daily_limit":20,"hourly_limit":5},{"day":2,"daily_limit":30,"hourly_limit":8},{"day":3,"daily_limit":40,"hourly_limit":10},{"day":4,"daily_limit":60,"hourly_limit":15},{"day":5,"daily_limit":80,"hourly_limit":20}]'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.sending_limits_config (id)
VALUES (true)
ON CONFLICT (id) DO NOTHING;
