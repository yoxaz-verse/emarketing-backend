// src/config/allowedTables.ts
export const ALLOWED_TABLES = [
  'leads',
  'operators',
  'users',
  'sequences',
  'sequence_steps',
  'sequence_analytics',
  'agents',
  'sequence_runs',
  'sequence_run_steps',
  'inboxes',
  'campaign_inboxes',
  'sending_domains',
  'campaigns',
  'campaign_leads',
  'api_keys',
  'smtp_accounts',
  'voice_agents',
  'campaign_voice_agents',
  'voice_calls',
  'system_events',
  'password_reset_tokens',
  'validation_runs',
  'lead_folders',
  'newsletter_subscribers',
  'newsletter_preferences',
  'newsletter_issues',
  'newsletter_send_jobs',
  'newsletter_send_logs',
  'unsubscribe_tokens'
] as const;

export type AllowedTable = typeof ALLOWED_TABLES[number];
