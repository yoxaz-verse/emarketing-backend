-- Ensure inbox warmup columns exist for campaign/inbox read paths.
ALTER TABLE inboxes
  ADD COLUMN IF NOT EXISTS warmup_enabled boolean NOT NULL DEFAULT false;

ALTER TABLE inboxes
  ADD COLUMN IF NOT EXISTS warmup_day integer NOT NULL DEFAULT 1;
