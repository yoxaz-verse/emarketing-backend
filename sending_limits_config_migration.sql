-- Global sending limits + warmup configuration
CREATE TABLE IF NOT EXISTS public.sending_limits_config (
  id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id = TRUE),
  min_inbox_health_score INTEGER NOT NULL DEFAULT 60,
  min_domain_health_score INTEGER NOT NULL DEFAULT 60,
  warmup_advance_min_health_score INTEGER NOT NULL DEFAULT 70,
  warmup_advance_max_consecutive_failures INTEGER NOT NULL DEFAULT 2,
  warmup_steps JSONB NOT NULL DEFAULT '[
    {"day":1,"daily_limit":20,"hourly_limit":5},
    {"day":2,"daily_limit":30,"hourly_limit":8},
    {"day":3,"daily_limit":40,"hourly_limit":10},
    {"day":4,"daily_limit":60,"hourly_limit":15},
    {"day":5,"daily_limit":80,"hourly_limit":20}
  ]'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO public.sending_limits_config (id)
VALUES (TRUE)
ON CONFLICT (id) DO NOTHING;
