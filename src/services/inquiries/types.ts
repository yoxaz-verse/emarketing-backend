export type InquiryStage = 'new' | 'reviewed' | 'qualified' | 'follow_up' | 'closed';
export type QuoteStatus = 'draft' | 'reviewed' | 'approved' | 'sent' | 'closed';

export type InquirySourceCapability = {
  id: string;
  code: string;
  name: string;
  mode: string;
  status: string;
  source_origin?: 'db' | 'fallback';
  webhook_secret?: string | null;
  supports_api: boolean;
  supports_webhook: boolean;
  supports_manual: boolean;
  supports_scrape: boolean;
  auth_ready: boolean;
  health_status: string;
  credentials_metadata?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  last_checked_at?: string | null;
};

export type InquiryFetchRun = {
  id: string;
  source_id: string | null;
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
};

export type InquiryConnectorRun = {
  id: string;
  fetch_run_id: string | null;
  source_id: string | null;
  source_code: string | null;
  mode: string;
  status: string;
  latency_ms: number | null;
  fetched_count: number;
  inserted_count: number;
  deduped_count: number;
  failed_count: number;
  error_message: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
};

export type BuyerInquiry = {
  id: string;
  inquiry_code: string;
  source_id: string | null;
  source_code: string | null;
  source_external_id: string | null;
  fetch_run_id: string | null;
  dedupe_hash: string | null;
  buyer_name: string | null;
  buyer_company: string | null;
  buyer_email: string | null;
  buyer_phone: string | null;
  buyer_country: string | null;
  subject: string | null;
  message: string;
  quantity_requested: string | null;
  product_interest: string | null;
  quantity_band: string | null;
  region: string | null;
  urgency: string | null;
  buyer_type: string | null;
  stage: InquiryStage;
  priority: string | null;
  owner: string | null;
  notes: string | null;
  coded: boolean;
  coded_at: string | null;
  coded_by: string | null;
  raw_payload: Record<string, unknown>;
  inquiry_received_at: string | null;
  created_by: string | null;
  operator_id: string | null;
  created_at: string;
  updated_at: string;
};

export type InquiryCodingPayload = {
  product_interest?: string | null;
  quantity_band?: string | null;
  region?: string | null;
  urgency?: string | null;
  buyer_type?: string | null;
  stage?: InquiryStage;
  priority?: string | null;
  owner?: string | null;
  notes?: string | null;
};

export type InquiryIngestItem = {
  source_external_id?: string | null;
  buyer_name?: string | null;
  buyer_company?: string | null;
  buyer_email?: string | null;
  buyer_phone?: string | null;
  buyer_country?: string | null;
  subject?: string | null;
  message: string;
  quantity_requested?: string | null;
  product_interest?: string | null;
  inquiry_received_at?: string | null;
  raw_payload?: Record<string, unknown>;
};

export type InquiryFilters = {
  source_code?: string | null;
  stage?: string | null;
  coded?: string | null;
  from?: string | null;
  to?: string | null;
  q?: string | null;
  page?: number;
  page_size?: number;
};

export type InquiryQuote = {
  id: string;
  quote_code: string;
  inquiry_id: string;
  price: number | null;
  quantity: string | null;
  currency: string | null;
  incoterm: string | null;
  validity_date: string | null;
  terms: string | null;
  status: QuoteStatus;
  manual_sent_at: string | null;
  sent_channel: string | null;
  owner: string | null;
  notes: string | null;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
  inquiry?: {
    inquiry_code: string;
    source_code: string | null;
    buyer_name: string | null;
    buyer_email: string | null;
    product_interest: string | null;
  } | null;
};

export type QuoteUpdatePayload = {
  price?: number | null;
  quantity?: string | null;
  currency?: string | null;
  incoterm?: string | null;
  validity_date?: string | null;
  terms?: string | null;
  status?: QuoteStatus;
  owner?: string | null;
  notes?: string | null;
  sent_channel?: string | null;
  mark_sent?: boolean;
};
