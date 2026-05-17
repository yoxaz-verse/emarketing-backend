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
    last_name: {
      db: 'last_name',
      behavior: 'plain',
    },
    company: {
      db: 'company',
      behavior: 'plain',
    },
    country: {
      db: 'country',
      behavior: 'plain',
    },
    job_title: {
      db: 'job_title',
      behavior: 'plain',
    },
    phone: {
      db: 'phone',
      behavior: 'plain',
    },
    linkedin_url: {
      db: 'linkedin_url',
      behavior: 'plain',
    },
    website: {
      db: 'website',
      behavior: 'plain',
    },
    company_description: {
      db: 'company_description',
      behavior: 'plain',
    },
    industry: {
      db: 'industry',
      behavior: 'plain',
    },
    employee_size: {
      db: 'employee_size',
      behavior: 'plain',
    },
    source: {
      db: 'source',
      behavior: 'plain',
    },
    notes: {
      db: 'notes',
      behavior: 'plain',
    },
    tags: {
      db: 'tags',
      behavior: 'plain',
    },
    lead_status: {
      db: 'lead_status',
      behavior: 'plain',
    },

    operator_id: {
      db: 'operator_id',
      behavior: 'plain',
    },
    folder_id: {
      db: 'folder_id',
      behavior: 'plain',
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
    validation_status: {
      db: 'validation_status',
      behavior: 'readonly',
    },
    disposable: {
      db: 'disposable',
      behavior: 'readonly',
    },
    role_based: {
      db: 'role_based',
      behavior: 'readonly',
    },
    free_provider: {
      db: 'free_provider',
      behavior: 'readonly',
    },
    risk_score: {
      db: 'risk_score',
      behavior: 'readonly',
    },
    suggestion: {
      db: 'suggestion',
      behavior: 'readonly',
    },
    mx_records: {
      db: 'mx_records',
      behavior: 'readonly',
    },
    provider: {
      db: 'provider',
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
  agents: {
    id: {
      db: 'id',
      behavior: 'readonly',
    },
    name: {
      db: 'name',
      behavior: 'plain',
    },
    provider: {
      db: 'provider',
      behavior: 'plain',
    },
    endpoint: {
      db: 'endpoint',
      behavior: 'plain',
    },
    headers_config: {
      db: 'headers_config',
      behavior: 'plain',
    },
    created_at: {
      db: 'created_at',
      behavior: 'readonly',
    },
  },
  sequence_runs: {
    id: {
      db: 'id',
      behavior: 'readonly',
    },
    sequence_id: {
      db: 'sequence_id',
      behavior: 'plain',
    },
    status: {
      db: 'status',
      behavior: 'plain',
    },
    context_json: {
      db: 'context_json',
      behavior: 'plain',
    },
    started_at: {
      db: 'started_at',
      behavior: 'readonly',
    },
    updated_at: {
      db: 'updated_at',
      behavior: 'readonly',
    },
  },
  sequence_run_steps: {
    id: {
      db: 'id',
      behavior: 'readonly',
    },
    run_id: {
      db: 'run_id',
      behavior: 'plain',
    },
    node_id: {
      db: 'node_id',
      behavior: 'plain',
    },
    status: {
      db: 'status',
      behavior: 'plain',
    },
    output_json: {
      db: 'output_json',
      behavior: 'plain',
    },
    error: {
      db: 'error',
      behavior: 'plain',
    },
    scheduled_for: {
      db: 'scheduled_for',
      behavior: 'plain',
    },
    completed_at: {
      db: 'completed_at',
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
    dkim_selector: {
      db: 'dkim_selector',
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
    warmup_enabled: {
      db: 'warmup_enabled',
      behavior: 'plain',
    },
    warmup_day: {
      db: 'warmup_day',
      behavior: 'plain',
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



  voice_agents: {
    id: {
      db: 'id',
      behavior: 'readonly',
    },
    name: {
      db: 'name',
      behavior: 'plain',
    },
    status: {
      db: 'status',
      behavior: 'plain',
    },
    languages: {
      db: 'languages',
      behavior: 'plain',
    },
    persona_type: {
      db: 'persona_type',
      behavior: 'plain',
    },
    assigned_number: {
      db: 'assigned_number',
      behavior: 'plain',
    },
  },
  campaign_voice_agents: {
    id: {
      db: 'id',
      behavior: 'readonly',
    },
    campaign_id: {
      db: 'campaign_id',
      behavior: 'plain',
    },
    voice_agent_id: {
      db: 'voice_agent_id',
      behavior: 'plain',
    },
    active: {
      db: 'active',
      behavior: 'plain',
    },
    priority: {
      db: 'priority',
      behavior: 'plain',
    },
  },
  voice_calls: {
    id: {
      db: 'id',
      behavior: 'readonly',
    },
    voice_agent_id: {
      db: 'voice_agent_id',
      behavior: 'plain',
    },
    campaign_id: {
      db: 'campaign_id',
      behavior: 'plain',
    },
    lead_id: {
      db: 'lead_id',
      behavior: 'plain',
    },
    outcome: {
      db: 'outcome',
      behavior: 'plain',
    },
    created_at: {
      db: 'created_at',
      behavior: 'readonly',
    },
  },
  system_events: {
    id: {
      db: 'id',
      behavior: 'readonly',
    },
    type: {
      db: 'type',
      behavior: 'plain',
    },
    entity: {
      db: 'entity',
      behavior: 'plain',
    },
    entity_id: {
      db: 'entity_id',
      behavior: 'plain',
    },
    message: {
      db: 'message',
      behavior: 'plain',
    },
    meta: {
      db: 'meta',
      behavior: 'plain',
    },
    created_at: {
      db: 'created_at',
      behavior: 'readonly',
    },
  },
  password_reset_tokens: {
    id: {
      db: 'id',
      behavior: 'readonly',
    },
    email: {
      db: 'email',
      behavior: 'plain',
    },
    otp_hash: {
      db: 'otp_hash',
      behavior: 'plain',
    },
    expires_at: {
      db: 'expires_at',
      behavior: 'plain',
    },
    verified: {
      db: 'verified',
      behavior: 'plain',
    },
    created_at: {
      db: 'created_at',
      behavior: 'readonly',
    },
  },
  validation_runs: {
    id: { db: 'id', behavior: 'readonly' },
    type: { db: 'type', behavior: 'plain' },
    status: { db: 'status', behavior: 'plain' },
    started_at: { db: 'started_at', behavior: 'readonly' },
    finished_at: { db: 'finished_at', behavior: 'readonly' },
    triggered_by: { db: 'triggered_by', behavior: 'readonly' },
    scope: { db: 'scope', behavior: 'readonly' },
    total_targeted: { db: 'total_targeted', behavior: 'readonly' },
    processed_count: { db: 'processed_count', behavior: 'readonly' },
    success_count: { db: 'success_count', behavior: 'readonly' },
    risky_count: { db: 'risky_count', behavior: 'readonly' },
    invalid_count: { db: 'invalid_count', behavior: 'readonly' },
    failed_count: { db: 'failed_count', behavior: 'readonly' },
    last_error: { db: 'last_error', behavior: 'readonly' },
    created_at: { db: 'created_at', behavior: 'readonly' },
    updated_at: { db: 'updated_at', behavior: 'readonly' },
  },
  lead_folders: {
    id: { db: 'id', behavior: 'readonly' },
    name: { db: 'name', behavior: 'plain' },
    operator_id: { db: 'operator_id', behavior: 'plain' },
    created_by: { db: 'created_by', behavior: 'plain' },
    created_at: { db: 'created_at', behavior: 'readonly' },
    updated_at: { db: 'updated_at', behavior: 'readonly' },
  },
  newsletter_subscribers: {
    id: { db: 'id', behavior: 'readonly' },
    email: { db: 'email', behavior: 'plain' },
    first_name: { db: 'first_name', behavior: 'plain' },
    last_name: { db: 'last_name', behavior: 'plain' },
    status: { db: 'status', behavior: 'plain' },
    consent_source: { db: 'consent_source', behavior: 'plain' },
    consent_evidence: { db: 'consent_evidence', behavior: 'plain' },
    consent_ip: { db: 'consent_ip', behavior: 'plain' },
    opted_in_at: { db: 'opted_in_at', behavior: 'readonly' },
    confirmed_at: { db: 'confirmed_at', behavior: 'readonly' },
    unsubscribed_at: { db: 'unsubscribed_at', behavior: 'readonly' },
    suppress_reason: { db: 'suppress_reason', behavior: 'plain' },
    is_suppressed: { db: 'is_suppressed', behavior: 'plain' },
    source_lead_id: { db: 'source_lead_id', behavior: 'plain' },
    created_at: { db: 'created_at', behavior: 'readonly' },
    updated_at: { db: 'updated_at', behavior: 'readonly' },
  },
  newsletter_preferences: {
    id: { db: 'id', behavior: 'readonly' },
    subscriber_id: { db: 'subscriber_id', behavior: 'plain' },
    category: { db: 'category', behavior: 'plain' },
    is_enabled: { db: 'is_enabled', behavior: 'plain' },
    created_at: { db: 'created_at', behavior: 'readonly' },
    updated_at: { db: 'updated_at', behavior: 'readonly' },
  },
  newsletter_issues: {
    id: { db: 'id', behavior: 'readonly' },
    title: { db: 'title', behavior: 'plain' },
    slug: { db: 'slug', behavior: 'readonly' },
    subject: { db: 'subject', behavior: 'plain' },
    body_html: { db: 'body_html', behavior: 'plain' },
    status: { db: 'status', behavior: 'plain' },
    audience_filters: { db: 'audience_filters', behavior: 'plain' },
    recurring_enabled: { db: 'recurring_enabled', behavior: 'plain' },
    recurring_rrule: { db: 'recurring_rrule', behavior: 'plain' },
    recurring_next_run_at: { db: 'recurring_next_run_at', behavior: 'plain' },
    scheduled_at: { db: 'scheduled_at', behavior: 'plain' },
    published_at: { db: 'published_at', behavior: 'readonly' },
    paused_at: { db: 'paused_at', behavior: 'readonly' },
    created_by: { db: 'created_by', behavior: 'plain' },
    created_at: { db: 'created_at', behavior: 'readonly' },
    updated_at: { db: 'updated_at', behavior: 'readonly' },
  },
  newsletter_send_jobs: {
    id: { db: 'id', behavior: 'readonly' },
    issue_id: { db: 'issue_id', behavior: 'plain' },
    subscriber_id: { db: 'subscriber_id', behavior: 'plain' },
    status: { db: 'status', behavior: 'plain' },
    scheduled_for: { db: 'scheduled_for', behavior: 'plain' },
    attempts: { db: 'attempts', behavior: 'plain' },
    last_error: { db: 'last_error', behavior: 'plain' },
    sent_at: { db: 'sent_at', behavior: 'readonly' },
    created_at: { db: 'created_at', behavior: 'readonly' },
    updated_at: { db: 'updated_at', behavior: 'readonly' },
  },
  newsletter_send_logs: {
    id: { db: 'id', behavior: 'readonly' },
    issue_id: { db: 'issue_id', behavior: 'plain' },
    subscriber_id: { db: 'subscriber_id', behavior: 'plain' },
    job_id: { db: 'job_id', behavior: 'plain' },
    inbox_id: { db: 'inbox_id', behavior: 'plain' },
    status: { db: 'status', behavior: 'plain' },
    provider_message_id: { db: 'provider_message_id', behavior: 'plain' },
    error: { db: 'error', behavior: 'plain' },
    created_at: { db: 'created_at', behavior: 'readonly' },
  },
  unsubscribe_tokens: {
    id: { db: 'id', behavior: 'readonly' },
    subscriber_id: { db: 'subscriber_id', behavior: 'plain' },
    purpose: { db: 'purpose', behavior: 'plain' },
    token_hash: { db: 'token_hash', behavior: 'readonly' },
    expires_at: { db: 'expires_at', behavior: 'plain' },
    consumed_at: { db: 'consumed_at', behavior: 'readonly' },
    meta: { db: 'meta', behavior: 'plain' },
    created_at: { db: 'created_at', behavior: 'readonly' },
  },
};
