export type ProviderType = 'preset' | 'custom';
export type AuthType = 'none' | 'api_key' | 'bearer' | 'custom_header';
export type MemoryStrategy = 'window' | 'summary';

export type MemoryPolicy = {
  strategy: MemoryStrategy;
  max_turns?: number;
  summary_trigger_tokens?: number;
};

export type AgentRecord = {
  id: string;
  name: string;
  provider: string;
  provider_type: ProviderType;
  base_url: string | null;
  endpoint: string | null;
  auth_type: AuthType;
  auth_header_name: string | null;
  auth_secret_encrypted: string | null;
  headers_config: Record<string, string>;
  default_model: string | null;
  default_path: string | null;
  role_key: string | null;
  memory_policy: MemoryPolicy;
  status: string;
  last_test_at: string | null;
  last_test_status: string | null;
  last_test_message: string | null;
  last_test_latency_ms: number | null;
  created_at: string;
  updated_at: string;
};

export type AgentResponse = Omit<AgentRecord, 'auth_secret_encrypted'> & {
  has_secret: boolean;
};

export type CreateOrUpdateAgentInput = {
  name?: string;
  provider?: string;
  provider_type?: ProviderType;
  base_url?: string;
  endpoint?: string;
  auth_type?: AuthType;
  auth_header_name?: string;
  auth_secret?: string;
  headers_config?: Record<string, string>;
  default_model?: string;
  default_path?: string;
  role_key?: string;
  memory_policy?: MemoryPolicy;
};

export type AgentTestRequest = {
  payload?: Record<string, unknown>;
  model?: string;
  path?: string;
};

export type AgentTestResponse = {
  success: boolean;
  statusCode: number;
  latencyMs: number;
  responsePreview: unknown;
  error?: string;
};
