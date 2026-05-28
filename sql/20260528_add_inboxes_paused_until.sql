-- Add one-hour temporary cooldown support for inboxes after undelivered outcomes.
ALTER TABLE inboxes
ADD COLUMN IF NOT EXISTS paused_until TIMESTAMPTZ NULL;

CREATE INDEX IF NOT EXISTS idx_inboxes_paused_until
ON inboxes (paused_until);
