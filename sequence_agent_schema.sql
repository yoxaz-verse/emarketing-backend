-- Node-based sequences + AI agents schema (v1)

-- Agents table
CREATE TABLE IF NOT EXISTS agents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'openflow',
  endpoint TEXT NOT NULL,
  headers_config JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Sequences table (extends existing if present)
CREATE TABLE IF NOT EXISTS sequences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  graph_json JSONB NOT NULL DEFAULT '{"nodes":[],"edges":[]}'::jsonb,
  status TEXT DEFAULT 'draft',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE sequences ADD COLUMN IF NOT EXISTS graph_json JSONB DEFAULT '{"nodes":[],"edges":[]}'::jsonb;
ALTER TABLE sequences ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'draft';
ALTER TABLE sequences ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

-- Sequence runs
CREATE TABLE IF NOT EXISTS sequence_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sequence_id UUID NOT NULL REFERENCES sequences(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending',
  context_json JSONB DEFAULT '{}'::jsonb,
  started_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Sequence run steps
CREATE TABLE IF NOT EXISTS sequence_run_steps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES sequence_runs(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled',
  output_json JSONB DEFAULT '{}'::jsonb,
  error TEXT,
  scheduled_for TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS sequence_run_steps_due_idx
  ON sequence_run_steps(status, scheduled_for);
