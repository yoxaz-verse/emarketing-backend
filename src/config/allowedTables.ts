// src/config/allowedTables.ts
export const ALLOWED_TABLES = [
  'leads',
  'operators',
  'users',
  'sequences',
  'sequence_steps',
  'sequence_analytics',
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
  'system_events'
] as const;

export type AllowedTable = typeof ALLOWED_TABLES[number];
