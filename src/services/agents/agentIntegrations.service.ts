import { supabase } from '../../supabase';
import { encryptSecret } from './encryption';
import {
  AgentRecord,
  AgentResponse,
  AgentTestRequest,
  CreateOrUpdateAgentInput,
} from './types';
import { executeAgentTest } from './providerExecution.service';

function sanitizeAgent(agent: AgentRecord): AgentResponse {
  const { auth_secret_encrypted, ...safe } = agent;
  return {
    ...safe,
    headers_config: safe.headers_config ?? {},
    has_secret: Boolean(auth_secret_encrypted),
  };
}

function normalizeInput(input: CreateOrUpdateAgentInput, partial = false) {
  const payload: Record<string, unknown> = {};

  if (!partial || input.name !== undefined) payload.name = String(input.name ?? '').trim();
  if (!partial || input.provider !== undefined) payload.provider = String(input.provider ?? 'custom').trim().toLowerCase();
  if (!partial || input.provider_type !== undefined) payload.provider_type = input.provider_type ?? 'custom';
  if (!partial || input.base_url !== undefined) payload.base_url = input.base_url?.trim() || null;
  if (!partial || input.endpoint !== undefined) payload.endpoint = input.endpoint?.trim() || null;
  if (!partial || input.auth_type !== undefined) payload.auth_type = input.auth_type ?? 'none';
  if (!partial || input.auth_header_name !== undefined) payload.auth_header_name = input.auth_header_name?.trim() || null;
  if (!partial || input.default_model !== undefined) payload.default_model = input.default_model?.trim() || null;
  if (!partial || input.default_path !== undefined) payload.default_path = input.default_path?.trim() || null;

  if (!partial || input.headers_config !== undefined) {
    payload.headers_config = input.headers_config && typeof input.headers_config === 'object'
      ? input.headers_config
      : {};
  }

  if (input.auth_secret && input.auth_secret.trim() !== '') {
    payload.auth_secret_encrypted = encryptSecret(input.auth_secret.trim());
  }

  payload.updated_at = new Date().toISOString();

  return payload;
}

export async function listAgents(): Promise<AgentResponse[]> {
  const { data, error } = await supabase
    .from('agents')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) {
    if (error.message?.includes('Could not find the table') || error.code === 'PGRST205') {
      return [];
    }
    throw error;
  }

  return (data ?? []).map((row: AgentRecord) => sanitizeAgent(row));
}

export async function createAgent(input: CreateOrUpdateAgentInput): Promise<AgentResponse> {
  const payload = normalizeInput(input, false);

  const { data, error } = await supabase
    .from('agents')
    .insert(payload)
    .select('*')
    .single();

  if (error) throw error;
  return sanitizeAgent(data as AgentRecord);
}

export async function getAgentById(id: string): Promise<AgentRecord> {
  const { data, error } = await supabase
    .from('agents')
    .select('*')
    .eq('id', id)
    .single();

  if (error) throw error;
  return data as AgentRecord;
}

export async function getAgentByIdSafe(id: string): Promise<AgentResponse> {
  const data = await getAgentById(id);
  return sanitizeAgent(data);
}

export async function updateAgent(id: string, input: CreateOrUpdateAgentInput): Promise<AgentResponse> {
  const payload = normalizeInput(input, true);

  const { data, error } = await supabase
    .from('agents')
    .update(payload)
    .eq('id', id)
    .select('*')
    .single();

  if (error) throw error;
  return sanitizeAgent(data as AgentRecord);
}

export async function deleteAgent(id: string): Promise<void> {
  const { error } = await supabase
    .from('agents')
    .delete()
    .eq('id', id);

  if (error) throw error;
}

export async function testAgentConnection(id: string, request: AgentTestRequest) {
  const agent = await getAgentById(id);
  const result = await executeAgentTest(agent, request);

  const status = result.success ? 'healthy' : 'error';
  await supabase
    .from('agents')
    .update({
      status,
      last_test_at: new Date().toISOString(),
      last_test_status: result.success ? 'success' : 'failure',
      last_test_message: result.success ? 'Connection test passed' : (result.error ?? 'Connection test failed'),
      last_test_latency_ms: result.latencyMs,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id);

  return result;
}
