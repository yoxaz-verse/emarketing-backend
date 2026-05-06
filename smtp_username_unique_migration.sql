-- Normalize usernames to lowercase/trimmed first
UPDATE smtp_accounts
SET username = LOWER(TRIM(username))
WHERE username IS NOT NULL;

-- This unique index enforces one SMTP account per username.
-- NOTE: If duplicates already exist, this statement will fail.
-- Resolve duplicates manually, then run this migration again.
CREATE UNIQUE INDEX IF NOT EXISTS smtp_accounts_username_unique_idx
  ON smtp_accounts (username);
