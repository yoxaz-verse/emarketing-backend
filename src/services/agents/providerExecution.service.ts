import { decryptSecret } from './encryption';
import { AgentRecord, AgentTestRequest, AgentTestResponse } from './types';

const DEFAULT_TIMEOUT_MS = 15000;

function toBaseUrl(agent: AgentRecord): string {
  const candidate = agent.base_url || agent.endpoint || '';
  if (!candidate) {
    throw new Error('Agent base URL/endpoint is missing');
  }
  return candidate.replace(/\/$/, '');
}

function toPath(agent: AgentRecord, request: AgentTestRequest): string {
  if (request.path && request.path.trim()) return request.path.trim();
  if (agent.default_path && agent.default_path.trim()) return agent.default_path.trim();
  if (agent.provider.toLowerCase().includes('openclaw') || agent.provider.toLowerCase().includes('openclo')) {
    return '/v1/responses';
  }
  return '/';
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

function buildBody(agent: AgentRecord, request: AgentTestRequest): Record<string, unknown> {
  if (request.payload && Object.keys(request.payload).length > 0) {
    return request.payload;
  }

  if (agent.provider.toLowerCase().includes('openclaw') || agent.provider.toLowerCase().includes('openclo')) {
    return {
      model: request.model || agent.default_model || 'gpt-4.1-mini',
      input: 'ping',
    };
  }

  return { ping: true };
}

function sanitizePreview(input: unknown): unknown {
  if (input == null) return null;
  if (typeof input === 'string') return input.slice(0, 2000);
  if (typeof input !== 'object') return input;

  const text = JSON.stringify(input);
  if (text.length <= 4000) return input;
  return { truncated: true, preview: text.slice(0, 4000) };
}

export async function executeAgentTest(
  agent: AgentRecord,
  request: AgentTestRequest
): Promise<AgentTestResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  const startedAt = Date.now();

  try {
    const headers = buildHeaders(agent);
    const body = buildBody(agent, request);
    const path = toPath(agent, request);
    const baseUrl = toBaseUrl(agent);
    const targetUrl = `${baseUrl}${path.startsWith('/') ? path : `/${path}`}`;

    const res = await fetch(targetUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const latencyMs = Date.now() - startedAt;
    const raw = await res.text();

    let parsed: unknown = null;
    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch {
      parsed = raw;
    }

    if (!res.ok) {
      return {
        success: false,
        statusCode: res.status,
        latencyMs,
        responsePreview: sanitizePreview(parsed),
        error: `Provider returned HTTP ${res.status}`,
      };
    }

    return {
      success: true,
      statusCode: res.status,
      latencyMs,
      responsePreview: sanitizePreview(parsed),
    };
  } catch (error: any) {
    const latencyMs = Date.now() - startedAt;
    const message = error?.name === 'AbortError' ? 'Provider request timed out' : String(error?.message ?? 'Unknown provider error');

    return {
      success: false,
      statusCode: 0,
      latencyMs,
      responsePreview: null,
      error: message,
    };
  } finally {
    clearTimeout(timeout);
  }
}
