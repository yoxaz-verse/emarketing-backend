import { supabase } from '../../supabase';
import { decryptSecret } from './encryption';
import { AgentRecord, MemoryPolicy } from './types';
import { safeFetch } from '../../utils/safeFetch';

const REQUEST_TIMEOUT_MS = 30000;
const DEFAULT_MEMORY_POLICY: MemoryPolicy = {
  strategy: 'summary',
  max_turns: 12,
  summary_trigger_tokens: 8000,
};

type ChatInput = {
  user_id: string;
  role_key: string;
  message: string;
  context?: Record<string, unknown>;
  request_id?: string;
};

type MemoryRow = {
  id: string;
  user_id: string;
  role_key: string;
  summary: string | null;
  recent_messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string; created_at?: string }>;
  message_count: number;
  approx_tokens: number;
  last_request_id: string | null;
  created_at: string;
  updated_at: string;
};

function ensurePolicy(policy: unknown): MemoryPolicy {
  if (!policy || typeof policy !== 'object') return DEFAULT_MEMORY_POLICY;
  const p = policy as MemoryPolicy;
  return {
    strategy: p.strategy === 'window' ? 'window' : 'summary',
    max_turns: Number.isFinite(Number(p.max_turns)) ? Math.max(4, Number(p.max_turns)) : 12,
    summary_trigger_tokens: Number.isFinite(Number(p.summary_trigger_tokens)) ? Math.max(1000, Number(p.summary_trigger_tokens)) : 8000,
  };
}

function approxTokens(messages: Array<{ content: string }>, summary?: string | null): number {
  const text = `${summary ?? ''}\n${messages.map((m) => m.content).join('\n')}`;
  return Math.ceil(text.length / 4);
}

function appendSummary(previous: string | null, chunk: Array<{ role: string; content: string }>): string {
  const preview = chunk
    .map((m) => `${m.role}: ${m.content}`)
    .join('\n')
    .slice(0, 2500);
  const base = previous ? `${previous}\n` : '';
  return `${base}[auto-summary]\n${preview}`.slice(0, 12000);
}

function extractAssistantReply(responseJson: any): string {
  if (!responseJson) return '';
  if (typeof responseJson.reply === 'string') return responseJson.reply;
  if (typeof responseJson.output_text === 'string') return responseJson.output_text;
  if (Array.isArray(responseJson.output)) {
    const parts = responseJson.output
      .flatMap((item: any) => Array.isArray(item?.content) ? item.content : [])
      .map((c: any) => c?.text?.value ?? c?.text ?? '')
      .filter(Boolean);
    if (parts.length) return parts.join('\n');
  }
  if (typeof responseJson.text === 'string') return responseJson.text;
  return JSON.stringify(responseJson).slice(0, 2000);
}

function buildHeaders(agent: AgentRecord): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(agent.headers_config ?? {}),
  };

  if (!agent.auth_type || agent.auth_type === 'none') return headers;
  if (!agent.auth_secret_encrypted) {
    throw new Error('Auth is enabled but no secret is configured');
  }

  const secret = decryptSecret(agent.auth_secret_encrypted);
  if (agent.auth_type === 'bearer') {
    headers.Authorization = `Bearer ${secret}`;
  } else if (agent.auth_type === 'api_key') {
    headers[agent.auth_header_name || 'x-api-key'] = secret;
  } else if (agent.auth_type === 'custom_header') {
    headers[agent.auth_header_name || 'Authorization'] = secret;
  }

  return headers;
}

function baseUrl(agent: AgentRecord): string {
  const b = agent.base_url || agent.endpoint || '';
  if (!b) throw new Error('Agent base URL/endpoint is missing');
  return b.replace(/\/$/, '');
}

async function ensureMemory(userId: string, roleKey: string): Promise<MemoryRow> {
  const { data: existing, error: readError } = await supabase
    .from('agent_memories')
    .select('*')
    .eq('user_id', userId)
    .eq('role_key', roleKey)
    .maybeSingle();

  if (readError) throw readError;
  if (existing) {
    return {
      ...existing,
      recent_messages: Array.isArray(existing.recent_messages) ? existing.recent_messages : [],
    } as MemoryRow;
  }

  const { data: created, error: createError } = await supabase
    .from('agent_memories')
    .insert({ user_id: userId, role_key: roleKey })
    .select('*')
    .single();

  if (createError) throw createError;
  return {
    ...created,
    recent_messages: Array.isArray(created.recent_messages) ? created.recent_messages : [],
  } as MemoryRow;
}

async function callOpenClaw(agent: AgentRecord, payload: Record<string, unknown>, requestId: string) {
  const headers = buildHeaders(agent);
  headers['x-request-id'] = requestId;

  const path = agent.default_path?.trim() || '/v1/responses';
  const url = `${baseUrl(agent)}${path.startsWith('/') ? path : `/${path}`}`;

  const attempt = async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await safeFetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      }, { timeoutMs: REQUEST_TIMEOUT_MS });

      const raw = await response.text();
      let parsed: unknown;
      try {
        parsed = raw ? JSON.parse(raw) : null;
      } catch {
        parsed = { raw };
      }

      if (!response.ok) {
        throw new Error(`OpenClaw HTTP ${response.status}: ${raw.slice(0, 500)}`);
      }

      return parsed as Record<string, unknown>;
    } finally {
      clearTimeout(timeout);
    }
  };

  try {
    return await attempt();
  } catch (error) {
    const message = String((error as Error)?.message ?? 'unknown error');
    if (message.includes('AbortError') || message.includes('timed out')) {
      throw new Error('OpenClaw request timed out');
    }
    return await attempt();
  }
}

export async function chatWithAgentRole(input: ChatInput) {
  const userId = String(input.user_id || '').trim();
  const roleKey = String(input.role_key || '').trim();
  const message = String(input.message || '').trim();
  const requestId = String(input.request_id || `req_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`);

  if (!userId) throw new Error('user_id is required');
  if (!roleKey) throw new Error('role_key is required');
  if (!message) throw new Error('message is required');

  const { data: priorRequest } = await supabase
    .from('agent_chat_requests')
    .select('*')
    .eq('user_id', userId)
    .eq('role_key', roleKey)
    .eq('request_id', requestId)
    .maybeSingle();

  if (priorRequest) {
    return {
      request_id: requestId,
      role_key: roleKey,
      reply: priorRequest.response_text ?? '',
      memory_stats: {
        reused: true,
      },
    };
  }

  const { data: agentData, error: agentError } = await supabase
    .from('agents')
    .select('*')
    .eq('role_key', roleKey)
    .single();

  if (agentError || !agentData) {
    throw new Error(`No active agent configured for role_key=${roleKey}`);
  }

  const agent = agentData as AgentRecord;
  if ((agent.status ?? '').toLowerCase() === 'disabled') {
    throw new Error(`Agent for role_key=${roleKey} is disabled`);
  }

  const policy = ensurePolicy(agent.memory_policy);
  const memory = await ensureMemory(userId, roleKey);
  const recent = Array.isArray(memory.recent_messages) ? memory.recent_messages : [];

  const openclawPayload = {
    role_key: roleKey,
    user_id: userId,
    input: message,
    model: agent.default_model || undefined,
    memory: {
      summary: memory.summary,
      recent_messages: recent,
      message_count: memory.message_count,
    },
    context: input.context ?? {},
  };

  const startedAt = Date.now();
  const responseJson = await callOpenClaw(agent, openclawPayload, requestId);
  const latencyMs = Date.now() - startedAt;
  const reply = extractAssistantReply(responseJson);

  const userMsg = { role: 'user' as const, content: message, created_at: new Date().toISOString() };
  const assistantMsg = { role: 'assistant' as const, content: reply, created_at: new Date().toISOString() };
  let nextRecent = [...recent, userMsg, assistantMsg];
  let nextSummary = memory.summary;

  const triggerTokens = policy.summary_trigger_tokens ?? 8000;
  const maxTurns = policy.max_turns ?? 12;

  if (policy.strategy === 'summary' && approxTokens(nextRecent, nextSummary) > triggerTokens && nextRecent.length > maxTurns) {
    const overflowCount = nextRecent.length - maxTurns;
    const overflow = nextRecent.slice(0, overflowCount);
    nextSummary = appendSummary(nextSummary, overflow);
    nextRecent = nextRecent.slice(overflowCount);
  }

  if (policy.strategy === 'window' && nextRecent.length > maxTurns) {
    nextRecent = nextRecent.slice(nextRecent.length - maxTurns);
  }

  const nextTokens = approxTokens(nextRecent, nextSummary);

  const { error: requestInsertError } = await supabase
    .from('agent_chat_requests')
    .insert({
      user_id: userId,
      role_key: roleKey,
      request_id: requestId,
      status: 'completed',
      response_text: reply,
      response_json: responseJson,
    });

  if (requestInsertError && !String(requestInsertError.message || '').toLowerCase().includes('duplicate')) {
    throw requestInsertError;
  }

  const { error: memoryUpdateError } = await supabase
    .from('agent_memories')
    .update({
      summary: nextSummary,
      recent_messages: nextRecent,
      message_count: (memory.message_count ?? 0) + 2,
      approx_tokens: nextTokens,
      last_request_id: requestId,
      updated_at: new Date().toISOString(),
    })
    .eq('id', memory.id);

  if (memoryUpdateError) throw memoryUpdateError;

  await supabase.from('agent_messages').insert([
    { memory_id: memory.id, request_id: requestId, role: 'user', content: message, metadata: { latency_ms: latencyMs } },
    { memory_id: memory.id, request_id: requestId, role: 'assistant', content: reply, metadata: { latency_ms: latencyMs } },
  ]);

  console.info('[OPENCLAW_CHAT_OK]', {
    roleKey,
    userId,
    requestId,
    latencyMs,
    approxTokens: nextTokens,
    messageCount: (memory.message_count ?? 0) + 2,
  });

  return {
    request_id: requestId,
    role_key: roleKey,
    reply,
    memory_stats: {
      strategy: policy.strategy,
      message_count: (memory.message_count ?? 0) + 2,
      approx_tokens: nextTokens,
      summary_present: Boolean(nextSummary),
      recent_messages: nextRecent.length,
    },
  };
}

export async function getRoleMemory(userId: string, roleKey: string) {
  if (!userId || !roleKey) throw new Error('user_id and role_key are required');
  const memory = await ensureMemory(userId, roleKey);
  return memory;
}

export async function resetRoleMemory(userId: string, roleKey: string) {
  if (!userId || !roleKey) throw new Error('user_id and role_key are required');
  const memory = await ensureMemory(userId, roleKey);

  await supabase.from('agent_messages').delete().eq('memory_id', memory.id);

  const { data, error } = await supabase
    .from('agent_memories')
    .update({
      summary: null,
      recent_messages: [],
      message_count: 0,
      approx_tokens: 0,
      last_request_id: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', memory.id)
    .select('*')
    .single();

  if (error) throw error;
  return data;
}
