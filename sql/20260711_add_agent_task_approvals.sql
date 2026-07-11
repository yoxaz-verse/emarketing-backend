ALTER TABLE agent_tasks
  ADD COLUMN IF NOT EXISTS approval_status text NOT NULL DEFAULT 'not_required',
  ADD COLUMN IF NOT EXISTS approved_by uuid NULL,
  ADD COLUMN IF NOT EXISTS approved_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS rejected_by uuid NULL,
  ADD COLUMN IF NOT EXISTS rejected_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS approval_notes text NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'agent_tasks_approval_status_check'
  ) THEN
    ALTER TABLE agent_tasks
      ADD CONSTRAINT agent_tasks_approval_status_check
      CHECK (approval_status IN ('not_required', 'pending', 'approved', 'rejected'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_agent_tasks_approval_status_created_at
  ON agent_tasks (approval_status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_tasks_role_approval_status
  ON agent_tasks (role_key, approval_status);

UPDATE agent_tasks
SET approval_status = 'not_required'
WHERE approval_status IS NULL;
