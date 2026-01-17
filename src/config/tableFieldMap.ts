export type FieldBehavior =
  | 'plain'
  | 'hashed'
  | 'readonly'
  | 'alias'
  | 'relation';


export type RelationMeta = {
  table: string;
  valueKey: string;
  labelKey: string;
};

export type FieldDefinition = {
  db: string;
  behavior: FieldBehavior;
  relation?: RelationMeta;
};


export const TABLE_FIELD_MAP: Record<
  string,
  Record<string, FieldDefinition>
> = {

  leads: {
    id: {
      db: 'id',
      behavior: 'readonly',
    },
    email: {
      db: 'email',
      behavior: 'plain',
    },
    first_name: {
      db: 'first_name',
      behavior: 'plain',
    },
    company: {
      db: 'company',
      behavior: 'plain',
    },

    operator_id: {
      db: 'operator_id',
      behavior: 'relation',
      relation: {
        table: 'operators',
        valueKey: 'id',
        labelKey: 'name',
      },
    },
    email_eligibility: {
      db: 'email_eligibility',
      behavior: 'readonly',
    },
    email_eligibility_reason: {
      db: 'email_eligibility_reason',
      behavior: 'readonly',
    },
    eligibility_processing: {
      db: 'eligibility_processing',
      behavior: 'readonly',
    },
    email_checked_at: {
      db: 'email_checked_at',
      behavior: 'readonly',
    },

    created_at: {
      db: 'created_at',
      behavior: 'readonly',
    },
  },
  users: {
    id: {
      db: 'id',
      behavior: 'plain',
    },
    auth_user_id: {
      db: 'auth_user_id',
      behavior: 'plain',
    },
    email: {
      db: 'email',
      behavior: 'plain',
    },
    role: {
      db: 'role',
      behavior: 'plain',
    },

    operator_id: {
      db: 'operator_id',
      behavior: 'plain',
    },
    created_at: {
      db: 'created_at',
      behavior: 'readonly',
    },
  },
  operators: {
    id: {
      db: 'id',
      behavior: 'readonly',
    },
    name: {
      db: 'name',
      behavior: 'alias',
    },
    region: {
      db: 'region',
      behavior: 'plain',
    },
    created_at: {
      db: 'created_at',
      behavior: 'readonly',
    },
  },
  sequence_analytics: {
    id: {
      db: 'id',
      behavior: 'readonly',
    },
    name: {
      db: 'name',
      behavior: 'plain',
    },
    is_active: {
      db: 'is_active',
      behavior: 'plain',
    },
    leads_enrolled: {
      db: 'leads_enrolled',
      behavior: 'plain',
    },
    completed: {
      db: 'completed',
      behavior: 'plain',
    }, stopped: {
      db: 'stopped',
      behavior: 'plain',
    },
    created_at: {
      db: 'created_at',
      behavior: 'readonly',
    },
  },
  sequences: {
    id: {
      db: 'id',
      behavior: 'readonly',
    },
    name: {
      db: 'name',
      behavior: 'plain',
    },
    is_active: {
      db: 'is_active',
      behavior: 'plain',
    },
    created_at: {
      db: 'created_at',
      behavior: 'readonly',
    },
  },
  smtp_accounts: {
    id: {
      db: 'id',
      behavior: 'readonly',
    },
    provider: {
      db: 'provider',
      behavior: 'plain', // mxroute | google (string)
    },
    host: {
      db: 'host',
      behavior: 'plain',
    },
    port: {
      db: 'port',
      behavior: 'plain',
    },
    username: {
      db: 'username',
      behavior: 'plain',
    },
    password: {
      db: 'password',
      behavior: 'plain',
    },
    encryption: {
      db: 'encryption',
      behavior: 'plain', // ssl | tls | starttls
    },
    sending_domain_id: {
      db: 'sending_domain_id',
      behavior: 'plain',
    },
    is_valid: {
      db: 'is_valid',
      behavior: 'plain',
    },

    created_at: {
      db: 'created_at',
      behavior: 'readonly',
    },
  },

  sending_domains: {
    id: {
      db: 'id',
      behavior: 'readonly',
    },
    domain: {
      db: 'domain',
      behavior: 'plain',
    },
    spf_verified: {
      db: 'spf_verified',
      behavior: 'plain',
    },
    dkim_verified: {
      db: 'dkim_verified',
      behavior: 'plain',
    },
    dmarc_verified: {
      db: 'dmarc_verified',
      behavior: 'plain',
    },
    daily_limit: {
      db: 'daily_limit',
      behavior: 'plain', // hard cap, not warm-up
    },
    hourly_limit: {
      db: 'hourly_limit',
      behavior: 'plain', // hard cap, not warm-up
    },
    health_score: {
      db: 'health_score',
      behavior: 'readonly',
    },
    created_at: {
      db: 'created_at',
      behavior: 'readonly',
    },
  },
  inboxes: {
    id: {
      db: 'id',
      behavior: 'readonly',
    },
    email_address: {
      db: 'email_address',
      behavior: 'plain',
    },
    operator_id: {
      db: 'operator_id',
      behavior: 'plain',
    },
    provider: {
      db: 'provider',
      behavior: 'plain', // mxroute | google
    },
    sending_domain_id: {
      db: 'sending_domain_id',
      behavior: 'plain',
    },
    smtp_account_id: {
      db: 'smtp_account_id',
      behavior: 'plain', // required for mxroute
    },
    daily_limit: {
      db: 'daily_limit',
      behavior: 'plain', // fallback cap
    },
    hourly_limit: {
      db: 'hourly_limit',
      behavior: 'plain', // fallback cap
    },
    health_score: {
      db: 'health_score',
      behavior: 'readonly',
    },
    sent_count: {
      db: 'sent_count',
      behavior: 'readonly',
    },
    failed_count: {
      db: 'failed_count',
      behavior: 'readonly',
    },
    replies_count: {
      db: 'replies_count',
      behavior: 'readonly',
    },
    consecutive_failures: {
      db: 'consecutive_failures',
      behavior: 'readonly',
    },
    is_paused: {
      db: 'is_paused',
      behavior: 'plain',
    },
    paused_reason: {
      db: 'paused_reason',
      behavior: 'plain',
    },
    created_at: {
      db: 'created_at',
      behavior: 'readonly',
    },
  },
  sequence_steps: {
    id: {
      db: 'id',
      behavior: 'readonly',
    },
    sequence_id: {
      db: 'sequence_id',
      behavior: 'plain',
    },
    step_number: {
      db: 'step_number',
      behavior: 'plain',
    },
    delay_days: {
      db: 'delay_days',
      behavior: 'plain',
    },
    subject: {
      db: 'subject',
      behavior: 'plain',
    },
    body: {
      db: 'body',
      behavior: 'plain',
    },
    created_at: {
      db: 'created_at',
      behavior: 'readonly',
    },
  },
  campaigns: {
    id: {
      db: 'id',
      behavior: 'readonly',
    },
    name: {
      db: 'name',
      behavior: 'plain',
    },
    sequence_id: {
      db: 'sequence_id',
      behavior: 'relation',
      relation: {
        table: 'sequences',
        valueKey: 'id',
        labelKey: 'name',
      },
    }, operator_id: {
      db: 'operator_id',
      behavior: 'relation',
      relation: {
        table: 'operators',
        valueKey: 'id',
        labelKey: 'name',
      },
    },

    status: {
      db: 'status',
      behavior: 'plain',
    },
    created_at: {
      db: 'created_at',
      behavior: 'readonly',
    },
  },
  campaign_leads: {
    id: {
      db: 'id',
      behavior: 'readonly',
    },
    campaign_id: {
      db: 'campaign_id',
      behavior: 'plain',
    },
    lead_id: {
      db: 'lead_id',
      behavior: 'plain',
    },
    status: {
      db: 'status',
      behavior: 'plain',
    },
    current_step: {
      db: 'current_step',
      behavior: 'plain',
    },
    last_sent_at: {
      db: 'last_sent_at',
      behavior: 'plain',
    },
    created_at: {
      db: 'created_at',
      behavior: 'readonly',
    },
  },
  campaign_inboxes: {
    id: {
      db: 'id',
      behavior: 'readonly',
    },
    campaign_id: {
      db: 'campaign_id',
      behavior: 'plain',
    },
    inbox_id: {
      db: 'inbox_id',
      behavior: 'plain',
    },
    created_at: {
      db: 'created_at',
      behavior: 'readonly',
    },
  },
  api_keys: {
    id: {
      db: 'id',
      behavior: 'plain',
    },

    // 🔴 MUST BE PLAIN — NOT readonly, NOT relation
    key_hash: {
      db: 'key_hash',
      behavior: 'plain',
    },

    // derived in lifecycle, written to DB
    role: {
      db: 'role',
      behavior: 'plain',
    },

    // 🔴 WRITE = plain
    user_id: {
      db: 'user_id',
      behavior: 'plain',
    },

    // 🔴 WRITE = plain
    operator_id: {
      db: 'operator_id',
      behavior: 'plain',
    },

    active: {
      db: 'active',
      behavior: 'plain',
    },

    last_used_at: {
      db: 'last_used_at',
      behavior: 'readonly',
    },

    created_at: {
      db: 'created_at',
      behavior: 'readonly',
    },
  },



};
