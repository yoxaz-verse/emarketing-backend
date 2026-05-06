ALTER TABLE sending_domains
ADD COLUMN IF NOT EXISTS dkim_selector TEXT;
