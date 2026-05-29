-- Segregate inboxes by mail process purpose.
ALTER TABLE inboxes
ADD COLUMN IF NOT EXISTS purpose TEXT;

UPDATE inboxes
SET purpose = 'campaign'
WHERE purpose IS NULL OR purpose = '';

ALTER TABLE inboxes
ALTER COLUMN purpose SET DEFAULT 'campaign';

ALTER TABLE inboxes
ALTER COLUMN purpose SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'inboxes_purpose_check'
  ) THEN
    ALTER TABLE inboxes
    ADD CONSTRAINT inboxes_purpose_check
    CHECK (purpose IN ('campaign', 'newsletter'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_inboxes_purpose ON inboxes (purpose);
