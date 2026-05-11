import crypto from 'crypto';
import { supabase } from '../../supabase';
import {
  CreateSocialPublishRequestInput,
  SocialConnectorCapability,
  SocialJobPhase,
  SocialJobStatus,
  SocialJobTimelineEvent,
  SocialPlatformCode,
  SocialPostInput,
} from './types';
import { executeSocialPublish, validateSocialPostInput } from './connectors';

function nowIso(): string {
  return new Date().toISOString();
}

function makeEvent(phase: SocialJobPhase, status: SocialJobStatus, message: string, errorCode?: string): SocialJobTimelineEvent {
  return { at: nowIso(), phase, status, message, error_code: errorCode };
}

function normalizedErrorCode(message: string): string {
  if (message.includes('required')) return 'VALIDATION_REQUIRED_FIELD';
  if (message.includes('must be')) return 'VALIDATION_INVALID_VALUE';
  return 'VALIDATION_ERROR';
}

function fallbackIdempotencyKey(input: CreateSocialPublishRequestInput, userId?: string | null): string {
  const digest = crypto
    .createHash('sha256')
    .update(JSON.stringify({ targets: input.targets, post_input: input.post_input, userId: userId ?? null }))
    .digest('hex');
  return `social-auto-${digest}`;
}

export async function listSocialConnectors() {
  const { data, error } = await supabase
    .from('social_connectors')
    .select('*')
    .order('name', { ascending: true });

  if (error) {
    if (error.code === 'PGRST205') return [];
    throw error;
  }

  return data ?? [];
}

async function getConnectorsByCodes(codes: string[]): Promise<Map<string, SocialConnectorCapability>> {
  const { data, error } = await supabase
    .from('social_connectors')
    .select('*')
    .in('code', codes);

  if (error) throw error;

  const map = new Map<string, SocialConnectorCapability>();
  for (const row of data ?? []) map.set(row.code, row as SocialConnectorCapability);
  return map;
}

async function createOrGetRequest(input: CreateSocialPublishRequestInput, userId?: string | null, operatorId?: string | null) {
  const idempotencyKey = (input.idempotency_key || '').trim() || fallbackIdempotencyKey(input, userId);

  const existing = await supabase
    .from('social_publish_requests')
    .select('*')
    .eq('idempotency_key', idempotencyKey)
    .maybeSingle();

  if (existing.error && existing.error.code !== 'PGRST116') throw existing.error;
  if (existing.data) return existing.data;

  const { data, error } = await supabase
    .from('social_publish_requests')
    .insert({
      idempotency_key: idempotencyKey,
      post_input: input.post_input,
      targets: input.targets,
      operator_id: operatorId ?? null,
      created_by: userId ?? null,
    })
    .select('*')
    .single();

  if (error) throw error;
  return data;
}

async function createJob(requestId: string, connector: SocialConnectorCapability, input: SocialPostInput, createdBy?: string | null) {
  const { data, error } = await supabase
    .from('social_publish_jobs')
    .insert({
      request_id: requestId,
      platform_code: connector.code,
      status: 'draft_created',
      phase: 'DRAFT_CREATE',
      post_input: input,
      scheduled_at: input.scheduled_at ?? null,
      timeline: [makeEvent('DRAFT_CREATE', 'draft_created', 'Draft payload created in panel')],
      attempts: 1,
      created_by: createdBy ?? null,
      updated_at: nowIso(),
    })
    .select('*')
    .single();

  if (error) throw error;
  return data;
}

async function patchJob(id: string, patch: Record<string, unknown>) {
  const { data, error } = await supabase
    .from('social_publish_jobs')
    .update({ ...patch, updated_at: nowIso() })
    .eq('id', id)
    .select('*')
    .single();

  if (error) throw error;
  return data;
}

async function executeFlow(job: any, connector: SocialConnectorCapability, input: SocialPostInput) {
  const timeline = Array.isArray(job.timeline) ? [...job.timeline] : [];
  const validationErrors = validateSocialPostInput(input);

  if (validationErrors.length > 0) {
    const message = validationErrors.join('; ');
    timeline.push(makeEvent('VALIDATE', 'failed', message, normalizedErrorCode(message)));
    return patchJob(job.id, {
      status: 'failed',
      phase: 'VALIDATE',
      validation_errors: validationErrors,
      error_code: normalizedErrorCode(message),
      error_message: message,
      timeline,
    });
  }

  timeline.push(makeEvent('VALIDATE', 'validated', 'Post validated successfully'));
  timeline.push(makeEvent('APPROVAL_PENDING', 'approval_pending', 'Post prepared and waiting for approval'));

  const execution = executeSocialPublish(connector, input);

  if (execution.status === 'manual_action_required') {
    timeline.push(makeEvent('PUBLISH', 'manual_action_required', 'Manual-assisted publish task generated'));
    return patchJob(job.id, {
      status: 'manual_action_required',
      phase: 'PUBLISH',
      manual_task: execution.manual_task ?? null,
      timeline,
    });
  }

  timeline.push(makeEvent('PUBLISH', 'published', 'Published successfully'));
  return patchJob(job.id, {
    status: 'published',
    phase: 'PUBLISH',
    external_post_id: execution.external_post_id ?? null,
    external_post_url: execution.external_post_url ?? null,
    timeline,
  });
}

export async function createSocialPublishJobs(input: CreateSocialPublishRequestInput, userId?: string | null, operatorId?: string | null) {
  const targets = Array.from(new Set((input.targets ?? []).map((t) => String(t).trim().toLowerCase()).filter(Boolean))) as SocialPlatformCode[];
  if (targets.length === 0) throw new Error('At least one target platform is required');

  const request = await createOrGetRequest({ ...input, targets }, userId, operatorId);

  const existingJobs = await supabase
    .from('social_publish_jobs')
    .select('*')
    .eq('request_id', request.id)
    .order('created_at', { ascending: true });

  if (!existingJobs.error && (existingJobs.data?.length ?? 0) > 0) {
    return {
      request_id: request.id,
      idempotency_key: request.idempotency_key,
      jobs: existingJobs.data,
    };
  }

  const connectorMap = await getConnectorsByCodes(targets);
  const missing = targets.filter((t) => !connectorMap.has(t));
  if (missing.length > 0) throw new Error(`Unknown platform(s): ${missing.join(', ')}`);

  const jobs: any[] = [];
  for (const target of targets) {
    const connector = connectorMap.get(target)!;
    const created = await createJob(request.id, connector, input.post_input, userId);
    const executed = await executeFlow(created, connector, input.post_input);
    jobs.push(executed);
  }

  return {
    request_id: request.id,
    idempotency_key: request.idempotency_key,
    jobs,
  };
}

export async function getSocialPublishJob(jobId: string) {
  const { data, error } = await supabase
    .from('social_publish_jobs')
    .select('*, social_publish_requests(*)')
    .eq('id', jobId)
    .single();

  if (error) throw error;
  return data;
}

export async function retrySocialPublishJob(jobId: string) {
  const { data, error } = await supabase
    .from('social_publish_jobs')
    .select('*')
    .eq('id', jobId)
    .single();

  if (error) throw error;
  const job = data;

  const { data: connector, error: connectorError } = await supabase
    .from('social_connectors')
    .select('*')
    .eq('code', job.platform_code)
    .single();

  if (connectorError) throw connectorError;

  const timeline = Array.isArray(job.timeline) ? [...job.timeline] : [];
  timeline.push(makeEvent('DRAFT_CREATE', 'draft_created', 'Retry initiated from panel'));

  const patched = await patchJob(job.id, {
    attempts: Number(job.attempts ?? 0) + 1,
    status: 'draft_created',
    phase: 'DRAFT_CREATE',
    timeline,
    error_code: null,
    error_message: null,
  });

  return executeFlow(patched, connector as SocialConnectorCapability, job.post_input as SocialPostInput);
}
