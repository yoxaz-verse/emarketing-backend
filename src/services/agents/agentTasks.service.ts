import { supabase } from '../../supabase';

export const ALLOWED_ROLE_KEYS = [
  'content_creator',
  'scraper',
  'image_prompt_creator',
  'email_sequence_creator',
  'lead_enrichment_agent',
  'blog_writer',
  'social_post_creator',
  'warehouse_content_creator',
  'research_agent',
] as const;

export const ALLOWED_TASK_TYPES = [
  'content_creation',
  'scraping',
  'image_prompt',
  'email_sequence',
  'lead_enrichment',
  'blog_draft',
  'social_post',
  'warehouse_content',
  'research',
  'newsletter_draft',
  'marketplace_listing',
] as const;

export const ALLOWED_TASK_STATUS = [
  'pending',
  'processing',
  'completed',
  'failed',
  'cancelled',
] as const;

const WORKER_RESULT_STATUS = ['completed', 'failed'] as const;

type AuthCtx = {
  userId?: string | null;
  operatorId?: string | null;
};

type CreateTaskInput = {
  integration_id?: string | null;
  role_key?: string;
  task_type?: string;
  input?: string;
  priority?: number;
  metadata?: Record<string, unknown>;
  source_entity?: string | null;
  source_entity_id?: string | null;
};

type ListTaskFilter = {
  status?: string;
  role_key?: string;
  task_type?: string;
  limit?: number;
  offset?: number;
};

type SubmitTaskResultInput = {
  status?: string;
  result?: string;
  structured_outputs?: unknown[];
  error?: string;
};

type CreateIntegrationInput = {
  name?: string;
  provider?: string;
  mode?: string;
  status?: string;
  base_url?: string | null;
  fallback_endpoint?: string | null;
  auth_type?: string | null;
  model?: string | null;
  role_key?: string | null;
  config?: Record<string, unknown>;
};

type CreateContextDocumentInput = {
  name?: string;
  role_key?: string;
  content?: string;
  active?: boolean;
  metadata?: Record<string, unknown>;
};

function ensureEnum(name: string, value: string, allowed: readonly string[]) {
  if (!allowed.includes(value)) {
    throw new Error(`${name} must be one of: ${allowed.join(', ')}`);
  }
}

function asObject(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  return input as Record<string, unknown>;
}

async function addTaskEvent(taskId: string, eventType: string, message?: string, payload?: Record<string, unknown>) {
  const { error } = await supabase.from('agent_task_events').insert({
    task_id: taskId,
    event_type: eventType,
    message: message ?? null,
    payload: payload ?? {},
  });

  if (error) throw error;
}

export async function createAgentTask(input: CreateTaskInput, auth: AuthCtx) {
  const roleKey = String(input.role_key ?? '').trim();
  const taskType = String(input.task_type ?? '').trim();
  const taskInput = String(input.input ?? '').trim();

  if (!roleKey) throw new Error('role_key is required');
  if (!taskType) throw new Error('task_type is required');
  if (!taskInput) throw new Error('input is required');

  ensureEnum('role_key', roleKey, ALLOWED_ROLE_KEYS);
  ensureEnum('task_type', taskType, ALLOWED_TASK_TYPES);

  const priority = Number.isFinite(Number(input.priority)) ? Number(input.priority) : 5;
  const metadata = asObject(input.metadata);

  const { data, error } = await supabase
    .from('agent_tasks')
    .insert({
      integration_id: input.integration_id ?? null,
      role_key: roleKey,
      task_type: taskType,
      input: taskInput,
      status: 'pending',
      priority,
      metadata,
      source_entity: input.source_entity ?? null,
      source_entity_id: input.source_entity_id ?? null,
      created_by: auth.userId ?? null,
      operator_id: auth.operatorId ?? null,
    })
    .select('*')
    .single();

  if (error) throw error;

  await addTaskEvent(data.id, 'created', 'Task created', {
    role_key: roleKey,
    task_type: taskType,
  });

  return data;
}

export async function listAgentTasks(filters: ListTaskFilter) {
  const limit = Number.isFinite(Number(filters.limit)) ? Math.min(Math.max(Number(filters.limit), 1), 100) : 25;
  const offset = Number.isFinite(Number(filters.offset)) ? Math.max(Number(filters.offset), 0) : 0;

  let query = supabase
    .from('agent_tasks')
    .select('*')
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (filters.status) {
    ensureEnum('status', filters.status, ALLOWED_TASK_STATUS);
    query = query.eq('status', filters.status);
  }

  if (filters.role_key) {
    ensureEnum('role_key', filters.role_key, ALLOWED_ROLE_KEYS);
    query = query.eq('role_key', filters.role_key);
  }

  if (filters.task_type) {
    ensureEnum('task_type', filters.task_type, ALLOWED_TASK_TYPES);
    query = query.eq('task_type', filters.task_type);
  }

  const { data, error } = await query;
  if (error) throw error;

  return data ?? [];
}

export async function getAgentTaskById(taskId: string) {
  const { data, error } = await supabase
    .from('agent_tasks')
    .select('*')
    .eq('id', taskId)
    .single();

  if (error) throw error;
  return data;
}

export async function pickNextAgentTask() {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const { data: rows, error: selectError } = await supabase
      .from('agent_tasks')
      .select('id, role_key, task_type, input, metadata, priority, created_at')
      .eq('status', 'pending')
      .order('priority', { ascending: true })
      .order('created_at', { ascending: true })
      .limit(1);

    if (selectError) throw selectError;
    const candidate = rows?.[0];
    if (!candidate) return null;

    const now = new Date().toISOString();
    const { data: updatedRows, error: updateError } = await supabase
      .from('agent_tasks')
      .update({
        status: 'processing',
        picked_at: now,
        updated_at: now,
      })
      .eq('id', candidate.id)
      .eq('status', 'pending')
      .select('*');

    if (updateError) throw updateError;

    if (updatedRows && updatedRows.length > 0) {
      const task = updatedRows[0];
      await addTaskEvent(task.id, 'picked', 'Task picked by worker', {
        attempt,
      });
      return task;
    }
  }

  return null;
}

export async function submitAgentTaskResult(taskId: string, input: SubmitTaskResultInput) {
  const status = String(input.status ?? '').trim();
  ensureEnum('status', status, WORKER_RESULT_STATUS);

  const now = new Date().toISOString();

  if (status === 'completed') {
    const structuredOutputs = Array.isArray(input.structured_outputs) ? input.structured_outputs : [];

    const { data, error } = await supabase
      .from('agent_tasks')
      .update({
        status: 'completed',
        result: String(input.result ?? ''),
        structured_outputs: structuredOutputs,
        error: null,
        completed_at: now,
        updated_at: now,
      })
      .eq('id', taskId)
      .select('*')
      .single();

    if (error) throw error;

    await addTaskEvent(taskId, 'completed', 'Task completed', {
      structured_outputs_count: structuredOutputs.length,
    });

    return data;
  }

  const { data, error } = await supabase
    .from('agent_tasks')
    .update({
      status: 'failed',
      error: String(input.error ?? 'Task failed'),
      completed_at: now,
      updated_at: now,
    })
    .eq('id', taskId)
    .select('*')
    .single();

  if (error) throw error;

  await addTaskEvent(taskId, 'failed', 'Task failed', {
    error: String(input.error ?? 'Task failed'),
  });

  return data;
}

export async function createAgentIntegration(input: CreateIntegrationInput, auth: AuthCtx) {
  const name = String(input.name ?? '').trim();
  const provider = String(input.provider ?? '').trim().toLowerCase();
  const mode = String(input.mode ?? '').trim();

  if (!name) throw new Error('name is required');
  if (!provider) throw new Error('provider is required');
  if (!mode) throw new Error('mode is required');

  const { data, error } = await supabase
    .from('agent_integrations')
    .insert({
      name,
      provider,
      mode,
      status: String(input.status ?? 'active').trim() || 'active',
      base_url: input.base_url ?? null,
      fallback_endpoint: input.fallback_endpoint ?? null,
      auth_type: input.auth_type ?? null,
      model: input.model ?? null,
      role_key: input.role_key ?? null,
      config: asObject(input.config),
      created_by: auth.userId ?? null,
      operator_id: auth.operatorId ?? null,
    })
    .select('*')
    .single();

  if (error) throw error;
  return data;
}

export async function listAgentIntegrations() {
  const { data, error } = await supabase
    .from('agent_integrations')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) throw error;
  return data ?? [];
}

export async function createAgentContextDocument(input: CreateContextDocumentInput, auth: AuthCtx) {
  const name = String(input.name ?? '').trim();
  const roleKey = String(input.role_key ?? '').trim();
  const content = String(input.content ?? '').trim();

  if (!name) throw new Error('name is required');
  if (!roleKey) throw new Error('role_key is required');
  if (!content) throw new Error('content is required');

  const { data, error } = await supabase
    .from('agent_context_documents')
    .insert({
      name,
      role_key: roleKey,
      content,
      active: input.active ?? true,
      metadata: asObject(input.metadata),
      created_by: auth.userId ?? null,
      operator_id: auth.operatorId ?? null,
    })
    .select('*')
    .single();

  if (error) throw error;
  return data;
}

export async function listAgentContextDocuments(activeOnly = true) {
  let query = supabase
    .from('agent_context_documents')
    .select('*')
    .order('created_at', { ascending: false });

  if (activeOnly) {
    query = query.eq('active', true);
  }

  const { data, error } = await query;
  if (error) throw error;

  return data ?? [];
}
