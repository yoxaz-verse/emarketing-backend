import crypto from 'crypto';
import { supabase } from '../../supabase';
import {
  ConnectorCapability,
  CreatePublishRequestInput,
  JobPhase,
  JobStatus,
  JobTimelineEvent,
  ListingInput,
} from './types';
import { executeConnectorPublish, validateListingInput } from './connectors';

function nowIso(): string {
  return new Date().toISOString();
}

function makeEvent(phase: JobPhase, status: JobStatus, message: string, errorCode?: string): JobTimelineEvent {
  return { at: nowIso(), phase, status, message, error_code: errorCode };
}

function normalizedErrorCode(message: string): string {
  if (message.includes('required')) return 'VALIDATION_REQUIRED_FIELD';
  if (message.includes('must be')) return 'VALIDATION_INVALID_VALUE';
  return 'VALIDATION_ERROR';
}

function fallbackIdempotencyKey(input: CreatePublishRequestInput, userId?: string | null): string {
  const digest = crypto
    .createHash('sha256')
    .update(JSON.stringify({ targets: input.targets, listing_input: input.listing_input, userId: userId ?? null }))
    .digest('hex');
  return `auto-${digest}`;
}

export async function listConnectors() {
  const { data, error } = await supabase
    .from('marketplace_connectors')
    .select('*')
    .order('name', { ascending: true });

  if (error) {
    if (error.code === 'PGRST205') return [];
    throw error;
  }

  return data ?? [];
}

async function getConnectorsByCodes(codes: string[]): Promise<Map<string, ConnectorCapability>> {
  const { data, error } = await supabase
    .from('marketplace_connectors')
    .select('*')
    .in('code', codes);

  if (error) throw error;

  const map = new Map<string, ConnectorCapability>();
  for (const row of data ?? []) map.set(row.code, row as ConnectorCapability);
  return map;
}

async function createOrGetRequest(input: CreatePublishRequestInput, userId?: string | null, operatorId?: string | null) {
  const idempotencyKey = (input.idempotency_key || '').trim() || fallbackIdempotencyKey(input, userId);

  const existing = await supabase
    .from('marketplace_publish_requests')
    .select('*')
    .eq('idempotency_key', idempotencyKey)
    .maybeSingle();

  if (existing.error && existing.error.code !== 'PGRST116') throw existing.error;
  if (existing.data) return existing.data;

  const { data, error } = await supabase
    .from('marketplace_publish_requests')
    .insert({
      idempotency_key: idempotencyKey,
      listing_input: input.listing_input,
      targets: input.targets,
      operator_id: operatorId ?? null,
      created_by: userId ?? null,
    })
    .select('*')
    .single();

  if (error) throw error;
  return data;
}

function validateMarketSpecific(connector: ConnectorCapability, input: ListingInput): string[] {
  const errors: string[] = [];
  if (connector.code === 'tradekey' && input.media.length > 6) errors.push('tradekey supports up to 6 media files');
  if (connector.code === 'ec21' && input.description.length > 5000) errors.push('ec21 description limit is 5000 chars');
  return errors;
}

async function upsertJob(requestId: string, connector: ConnectorCapability, input: ListingInput, createdBy?: string | null) {
  const { data, error } = await supabase
    .from('marketplace_publish_jobs')
    .insert({
      request_id: requestId,
      marketplace_code: connector.code,
      status: 'draft_created',
      phase: 'DRAFT_CREATE',
      listing_input: input,
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
    .from('marketplace_publish_jobs')
    .update({ ...patch, updated_at: nowIso() })
    .eq('id', id)
    .select('*')
    .single();

  if (error) throw error;
  return data;
}

async function executeFlow(job: any, connector: ConnectorCapability, input: ListingInput) {
  const timeline = Array.isArray(job.timeline) ? [...job.timeline] : [];

  const baseErrors = validateListingInput(input);
  const mapperErrors = validateMarketSpecific(connector, input);
  const allValidationErrors = [...baseErrors, ...mapperErrors];

  if (allValidationErrors.length > 0) {
    const message = allValidationErrors.join('; ');
    timeline.push(makeEvent('VALIDATE', 'failed', message, normalizedErrorCode(message)));
    return patchJob(job.id, {
      status: 'failed',
      phase: 'VALIDATE',
      validation_errors: allValidationErrors,
      error_code: normalizedErrorCode(message),
      error_message: message,
      timeline,
    });
  }

  timeline.push(makeEvent('VALIDATE', 'validated', 'Listing validated successfully'));
  timeline.push(makeEvent('APPROVAL_PENDING', 'approval_pending', 'Draft prepared and waiting for approval'));

  const execution = executeConnectorPublish(connector, input);

  if (execution.status === 'partner_onboarding_required') {
    timeline.push(makeEvent('PUBLISH', 'partner_onboarding_required', 'Partner onboarding required before publish'));
    return patchJob(job.id, {
      status: 'partner_onboarding_required',
      phase: 'PUBLISH',
      partner_onboarding: execution.partner_onboarding ?? null,
      timeline,
    });
  }

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
    external_listing_id: execution.external_listing_id ?? null,
    external_listing_url: execution.external_listing_url ?? null,
    timeline,
  });
}

export async function createPublishJobs(input: CreatePublishRequestInput, userId?: string | null, operatorId?: string | null) {
  const targets = Array.from(new Set((input.targets ?? []).map((t) => String(t).trim().toLowerCase()).filter(Boolean)));
  if (targets.length === 0) throw new Error('At least one target marketplace is required');

  const request = await createOrGetRequest({ ...input, targets }, userId, operatorId);

  const existingJobs = await supabase
    .from('marketplace_publish_jobs')
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
  if (missing.length > 0) throw new Error(`Unknown marketplace(s): ${missing.join(', ')}`);

  const jobs: any[] = [];
  for (const target of targets) {
    const connector = connectorMap.get(target)!;
    const created = await upsertJob(request.id, connector, input.listing_input, userId);
    const executed = await executeFlow(created, connector, input.listing_input);
    jobs.push(executed);
  }

  return {
    request_id: request.id,
    idempotency_key: request.idempotency_key,
    jobs,
  };
}

export async function getPublishJob(jobId: string) {
  const { data, error } = await supabase
    .from('marketplace_publish_jobs')
    .select('*, marketplace_publish_requests(*)')
    .eq('id', jobId)
    .single();

  if (error) throw error;
  return data;
}

export async function retryPublishJob(jobId: string) {
  const { data, error } = await supabase
    .from('marketplace_publish_jobs')
    .select('*')
    .eq('id', jobId)
    .single();

  if (error) throw error;
  const job = data;

  const { data: connector, error: connectorError } = await supabase
    .from('marketplace_connectors')
    .select('*')
    .eq('code', job.marketplace_code)
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

  return executeFlow(patched, connector as ConnectorCapability, job.listing_input as ListingInput);
}
