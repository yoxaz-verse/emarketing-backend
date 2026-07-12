export type IndustryOpportunityCategory =
  | 'seed_funding'
  | 'grant'
  | 'accelerator'
  | 'pitch_event'
  | 'demo_day'
  | 'investor_call'
  | 'ecosystem_program';

export type IndustryOpportunityStatus =
  | 'new'
  | 'reviewed'
  | 'shortlisted'
  | 'applied'
  | 'not_relevant'
  | 'closed';

export type IndustrySourceMode = 'manual' | 'rss' | 'api' | 'webhook';

export type IndustryIntelligenceSource = {
  id: string;
  code: string;
  name: string;
  mode: IndustrySourceMode;
  status: string;
  region: string | null;
  sector_focus: string[] | null;
  supports_fetch: boolean;
  supports_manual: boolean;
  auth_ready: boolean;
  health_status: string;
  metadata: Record<string, unknown>;
  last_checked_at: string | null;
  created_at: string;
  updated_at: string;
  source_origin?: 'db' | 'fallback';
};

export type IndustryFetchRun = {
  id: string;
  source_code: string | null;
  trigger_mode: string;
  status: string;
  total_received: number;
  inserted_count: number;
  deduped_count: number;
  failed_count: number;
  error_summary: string | null;
  started_at: string;
  completed_at: string | null;
  created_by: string | null;
  operator_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
};

export type IndustryOpportunity = {
  id: string;
  source_id: string | null;
  source_code: string | null;
  source_name: string | null;
  source_url: string | null;
  title: string;
  summary: string | null;
  category: IndustryOpportunityCategory;
  sector: string | null;
  geography: string | null;
  funding_stage: string | null;
  amount_text: string | null;
  deadline_date: string | null;
  opportunity_date: string | null;
  organizer_or_investor: string | null;
  relevance_score: number | null;
  status: IndustryOpportunityStatus;
  owner: string | null;
  notes: string | null;
  tags: string[];
  useful_for_funding: boolean;
  useful_for_clients: boolean;
  useful_for_partnerships: boolean;
  useful_for_content: boolean;
  dedupe_hash: string | null;
  raw_payload: Record<string, unknown>;
  fetched_run_id: string | null;
  created_by: string | null;
  operator_id: string | null;
  created_at: string;
  updated_at: string;
};

export type IndustryOpportunityInput = {
  title?: string | null;
  summary?: string | null;
  source_name?: string | null;
  source_url?: string | null;
  category?: string | null;
  sector?: string | null;
  geography?: string | null;
  funding_stage?: string | null;
  amount_text?: string | null;
  deadline_date?: string | null;
  opportunity_date?: string | null;
  organizer_or_investor?: string | null;
  relevance_score?: number | string | null;
  tags?: string[] | string | null;
  useful_for_funding?: boolean | null;
  useful_for_clients?: boolean | null;
  useful_for_partnerships?: boolean | null;
  useful_for_content?: boolean | null;
  raw_payload?: Record<string, unknown>;
};

export type IndustryOpportunityPatch = {
  category?: string | null;
  sector?: string | null;
  geography?: string | null;
  funding_stage?: string | null;
  status?: string | null;
  relevance_score?: number | string | null;
  owner?: string | null;
  notes?: string | null;
  tags?: string[] | string | null;
  useful_for_funding?: boolean | null;
  useful_for_clients?: boolean | null;
  useful_for_partnerships?: boolean | null;
  useful_for_content?: boolean | null;
};

export type IndustryOpportunityFilters = {
  source_code?: string | null;
  category?: string | null;
  sector?: string | null;
  funding_stage?: string | null;
  status?: string | null;
  from?: string | null;
  to?: string | null;
  q?: string | null;
  page?: number;
  page_size?: number;
};
