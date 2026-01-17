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
  'smtp_accounts'
  ] as const;
  
  export type AllowedTable = typeof ALLOWED_TABLES[number];
  