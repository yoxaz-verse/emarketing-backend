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
import {
  manualFallback,
  normalizeProviderError,
  publishedResult,
  validateSocialPostInput,
} from './connectors';
import { publishLinkedInTextLink } from './linkedin.client';
import { getConnectionStatuses, getOperatorPlatformConnection, hasOAuthAppConfig, markConnectionFailure } from './socialAuth.service';

type SocialConnectionReadiness = {
  platform_code: string;
  status: 'connected' | 'expired' | 'missing_scope' | 'disconnected';
  reason: string | null;
  scopes: string[];
  expires_at: string | null;
  metadata: Record<string, unknown>;
};

export type SocialTargetReadinessDetail = {
  platform_code: string;
  status: 'ready' | 'unknown_platform' | 'not_schedulable' | 'not_publishable' | 'unconfigured' | 'disconnected' | 'expired' | 'missing_scope';
  reason: string;
  missing_fields: string[];
};

export class SocialTargetReadinessError extends Error {
  code = 'SOCIAL_TARGET_NOT_READY';
  status = 400;
  details: SocialTargetReadinessDetail[];

  constructor(details: SocialTargetReadinessDetail[]) {
    super(buildSocialTargetReadinessMessage(details));
    this.name = 'SocialTargetReadinessError';
    this.details = details;
  }
}

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

function platformLabel(platform: string): string {
  const normalized = String(platform || '').trim().toLowerCase();
  if (normalized === 'linkedin') return 'LinkedIn';
  if (normalized === 'meta') return 'Meta';
  if (normalized === 'reddit') return 'Reddit';
  if (normalized === 'telegram') return 'Telegram';
  if (normalized === 'whatsapp') return 'WhatsApp';
  return normalized || 'Platform';
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item ?? '').trim()).filter(Boolean);
}

function connectorMissingFields(connector?: SocialConnectorCapability | null): string[] {
  const metadata = (connector?.metadata && typeof connector.metadata === 'object') ? connector.metadata : {};
  return asStringArray((metadata as Record<string, unknown>).missing_fields);
}

function connectorAppConfigured(connector?: SocialConnectorCapability | null): boolean {
  if (!connector) return false;
  const metadata = (connector.metadata && typeof connector.metadata === 'object') ? connector.metadata : {};
  const appConfigured = (metadata as Record<string, unknown>).app_configured;
  const oauthAppConfigured = (metadata as Record<string, unknown>).oauth_app_configured;
  const missingFields = connectorMissingFields(connector);
  if (appConfigured === false || oauthAppConfigured === false) return false;
  return missingFields.length === 0;
}

export function evaluateSocialTargetReadiness(params: {
  platform: string;
  connector?: SocialConnectorCapability | null;
  connection?: SocialConnectionReadiness | null;
}): SocialTargetReadinessDetail | null {
  const platform = String(params.platform || '').trim().toLowerCase();
  const label = platformLabel(platform);
  const connector = params.connector ?? null;
  const connection = params.connection ?? null;

  if (!connector) {
    return {
      platform_code: platform,
      status: 'unknown_platform',
      reason: `${label} connector is not configured in backend.`,
      missing_fields: requiredFieldsByPlatform(platform),
    };
  }

  if (!connector.can_schedule) {
    return {
      platform_code: platform,
      status: 'not_schedulable',
      reason: `${label} connector cannot schedule posts yet.`,
      missing_fields: [],
    };
  }

  if (!connector.can_publish) {
    return {
      platform_code: platform,
      status: 'not_publishable',
      reason: `${label} connector cannot publish posts yet.`,
      missing_fields: [],
    };
  }

  if (!connectorAppConfigured(connector)) {
    const missingFields = connectorMissingFields(connector);
    return {
      platform_code: platform,
      status: 'unconfigured',
      reason: missingFields.length > 0
        ? `${label} app credentials are incomplete: ${missingFields.join(', ')}.`
        : `${label} app credentials are not configured.`,
      missing_fields: missingFields.length > 0 ? missingFields : requiredFieldsByPlatform(platform),
    };
  }

  if (!connection) {
    return {
      platform_code: platform,
      status: 'disconnected',
      reason: `${label} is not connected for this operator.`,
      missing_fields: [],
    };
  }

  if (connection.status !== 'connected') {
    return {
      platform_code: platform,
      status: connection.status,
      reason: connection.reason || `${label} status: ${connection.status}.`,
      missing_fields: [],
    };
  }

  if (platform === 'linkedin' && !String(connection.metadata?.actor_urn ?? '').trim()) {
    return {
      platform_code: platform,
      status: 'disconnected',
      reason: 'LinkedIn actor/member URN required for publishing. Add Actor / Member URN in Configure, save, then reconnect LinkedIn.',
      missing_fields: ['actor_urn'],
    };
  }

  return null;
}

export function buildSocialTargetReadinessMessage(details: SocialTargetReadinessDetail[]): string {
  if (details.length === 0) return 'Selected social targets are not ready.';
  if (details.length === 1) return details[0].reason;
  return `Selected social targets are not ready: ${details.map((detail) => detail.reason).join(' ')}`;
}

function fallbackIdempotencyKey(input: CreateSocialPublishRequestInput, userId?: string | null): string {
  const digest = crypto
    .createHash('sha256')
    .update(JSON.stringify({ targets: input.targets, post_input: input.post_input, userId: userId ?? null, nonce: Date.now() }))
    .digest('hex');
  return `social-auto-${digest}`;
}

function isFutureSchedule(input: SocialPostInput): boolean {
  if (!input.scheduled_at) return false;
  const scheduledAt = new Date(input.scheduled_at);
  return !Number.isNaN(scheduledAt.getTime()) && scheduledAt.getTime() > Date.now();
}

function isDueSchedule(input: SocialPostInput): boolean {
  if (!input.scheduled_at) return true;
  const scheduledAt = new Date(input.scheduled_at);
  return !Number.isNaN(scheduledAt.getTime()) && scheduledAt.getTime() <= Date.now();
}

function canEditJobStatus(status: unknown): boolean {
  return ['scheduled', 'draft_created', 'validated', 'approval_pending', 'failed', 'manual_action_required'].includes(String(status ?? ''));
}

function terminalJobStatus(status: unknown): boolean {
  return ['published', 'failed', 'manual_action_required'].includes(String(status ?? ''));
}

function requiredFieldsByPlatform(platform: string): string[] {
  if (platform === 'linkedin') return ['client_id', 'client_secret', 'redirect_uri'];
  if (platform === 'meta') return ['app_id', 'app_secret', 'redirect_uri'];
  if (platform === 'reddit') return ['client_id', 'client_secret', 'redirect_uri', 'user_agent'];
  if (platform === 'telegram') return ['bot_token', 'chat_id'];
  if (platform === 'whatsapp') return ['phone_number_id', 'business_account_id', 'access_token'];
  return [];
}

function missingConfigFieldsForPlatform(platform: string, row: any | null): string[] {
  const required = requiredFieldsByPlatform(platform);
  if (!row) return required;

  const metadata = (row.metadata && typeof row.metadata === 'object') ? row.metadata : {};
  const clientId = String(row.client_id ?? '').trim();
  const redirectUri = String(row.redirect_uri ?? '').trim();
  const hasSecret = Boolean(String(row.client_secret_encrypted ?? '').trim());

  const snapshot: Record<string, string> = {};
  if (platform === 'linkedin') {
    snapshot.client_id = clientId;
    snapshot.client_secret = hasSecret ? '***' : '';
    snapshot.redirect_uri = redirectUri;
  } else if (platform === 'meta') {
    snapshot.app_id = clientId;
    snapshot.app_secret = hasSecret ? '***' : '';
    snapshot.redirect_uri = redirectUri;
  } else if (platform === 'reddit') {
    snapshot.client_id = clientId;
    snapshot.client_secret = hasSecret ? '***' : '';
    snapshot.redirect_uri = redirectUri;
    snapshot.user_agent = String((metadata as any).user_agent ?? '').trim();
  } else if (platform === 'telegram') {
    snapshot.bot_token = hasSecret ? '***' : '';
    snapshot.chat_id = String((metadata as any).chat_id ?? '').trim();
  } else if (platform === 'whatsapp') {
    snapshot.phone_number_id = String((metadata as any).phone_number_id ?? clientId ?? '').trim();
    snapshot.business_account_id = String((metadata as any).business_account_id ?? '').trim();
    snapshot.access_token = hasSecret ? '***' : '';
  }

  return required.filter((key) => !String(snapshot[key] ?? '').trim());
}

function mergePlatformConfigRow(operatorRow: any | null, globalRow: any | null): any | null {
  if (!operatorRow && !globalRow) return null;
  const row = operatorRow ?? globalRow;
  const operatorMeta = (operatorRow?.metadata && typeof operatorRow.metadata === 'object') ? operatorRow.metadata : {};
  const globalMeta = (globalRow?.metadata && typeof globalRow.metadata === 'object') ? globalRow.metadata : {};
  return {
    ...row,
    client_id: String(operatorRow?.client_id ?? globalRow?.client_id ?? ''),
    redirect_uri: String(operatorRow?.redirect_uri ?? globalRow?.redirect_uri ?? ''),
    client_secret_encrypted: String(operatorRow?.client_secret_encrypted ?? globalRow?.client_secret_encrypted ?? ''),
    metadata: {
      ...globalMeta,
      ...operatorMeta,
    },
  };
}

export async function listSocialConnectors(userId?: string | null, operatorId?: string | null) {
  const { data, error } = await supabase
    .from('social_connectors')
    .select('*')
    .order('name', { ascending: true });

  if (error) {
    if (error.code === 'PGRST205') return [];
    throw error;
  }

  const rows = (data ?? []) as SocialConnectorCapability[];
  if (!userId || !operatorId) return rows;

  const [connectionStatuses, oauthConfigStatuses, operatorAppRowsResult, globalAppRowsResult] = await Promise.all([
    getConnectionStatuses(userId, operatorId),
    Promise.all(
      rows.map(async (row) => ({
        code: row.code,
        oauthAppConfigured: await hasOAuthAppConfig(row.code, operatorId),
      }))
    ),
    supabase
      .from('social_operator_oauth_apps')
      .select('*')
      .eq('operator_id', operatorId)
      .eq('active', true),
    supabase
      .from('social_global_oauth_apps')
      .select('*')
      .eq('active', true),
  ]);

  if (operatorAppRowsResult.error && operatorAppRowsResult.error.code !== 'PGRST205' && operatorAppRowsResult.error.code !== '42P01') {
    throw operatorAppRowsResult.error;
  }
  if (globalAppRowsResult.error && globalAppRowsResult.error.code !== 'PGRST205' && globalAppRowsResult.error.code !== '42P01') {
    throw globalAppRowsResult.error;
  }

  const operatorAppByPlatform = new Map<string, any>();
  for (const appRow of operatorAppRowsResult.data ?? []) {
    operatorAppByPlatform.set(String((appRow as any).platform_code ?? '').toLowerCase(), appRow);
  }
  const globalAppByPlatform = new Map<string, any>();
  for (const appRow of globalAppRowsResult.data ?? []) {
    globalAppByPlatform.set(String((appRow as any).platform_code ?? '').toLowerCase(), appRow);
  }

  const typedConnectionStatuses = connectionStatuses as SocialConnectionReadiness[];
  const connectionByCode = new Map<string, SocialConnectionReadiness>(typedConnectionStatuses.map((s: SocialConnectionReadiness) => [s.platform_code, s]));
  const oauthConfigByCode = new Map(oauthConfigStatuses.map((s) => [s.code, s.oauthAppConfigured]));

  return rows.map((row) => {
    const appRow = mergePlatformConfigRow(
      operatorAppByPlatform.get(row.code) ?? null,
      globalAppByPlatform.get(row.code) ?? null
    );
    const missingFields = missingConfigFieldsForPlatform(row.code, appRow);
    const appConfigured = missingFields.length === 0;
    const oauthAppConfigured = Boolean(oauthConfigByCode.get(row.code));
    const connection = connectionByCode.get(row.code);
    const connected = connection?.status === 'connected';
    return {
      ...row,
      credentials_active: connected,
      auth_type: oauthAppConfigured ? 'oauth2' : 'none',
      status: connected ? 'api_enabled' : 'manual_assisted',
      metadata: {
        ...(row.metadata ?? {}),
        oauth_app_configured: oauthAppConfigured,
        app_configured: appConfigured,
        missing_fields: missingFields,
        connection_status: connection?.status ?? 'disconnected',
        connection_reason: connection?.reason ?? null,
      },
    } as SocialConnectorCapability;
  });
}

async function assertSocialTargetsReady(targets: SocialPlatformCode[], userId?: string | null, operatorId?: string | null): Promise<Map<string, SocialConnectorCapability>> {
  if (!userId || !operatorId) {
    const details = targets.map((target) => ({
      platform_code: target,
      status: 'disconnected' as const,
      reason: `${platformLabel(target)} requires user and operator context before scheduling.`,
      missing_fields: [],
    }));
    throw new SocialTargetReadinessError(details);
  }

  const [connectors, connections] = await Promise.all([
    listSocialConnectors(userId, operatorId),
    getConnectionStatuses(userId, operatorId),
  ]);
  const connectorMap = new Map<string, SocialConnectorCapability>();
  for (const connector of connectors) connectorMap.set(connector.code, connector);
  const connectionMap = new Map<string, SocialConnectionReadiness>();
  for (const connection of connections) connectionMap.set(connection.platform_code, connection as SocialConnectionReadiness);

  const failures = targets
    .map((target) => evaluateSocialTargetReadiness({
      platform: target,
      connector: connectorMap.get(target) ?? null,
      connection: connectionMap.get(target) ?? null,
    }))
    .filter((detail): detail is SocialTargetReadinessDetail => Boolean(detail));

  if (failures.length > 0) throw new SocialTargetReadinessError(failures);
  return connectorMap;
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

async function createJob(
  requestId: string,
  connector: SocialConnectorCapability,
  input: SocialPostInput,
  createdBy?: string | null,
  operatorId?: string | null
) {
  const scheduled = isFutureSchedule(input);
  const { data, error } = await supabase
    .from('social_publish_jobs')
    .insert({
      request_id: requestId,
      platform_code: connector.code,
      status: scheduled ? 'scheduled' : 'draft_created',
      phase: scheduled ? 'APPROVAL_PENDING' : 'DRAFT_CREATE',
      post_input: input,
      scheduled_at: input.scheduled_at ?? null,
      timeline: [
        makeEvent(
          scheduled ? 'APPROVAL_PENDING' : 'DRAFT_CREATE',
          scheduled ? 'scheduled' : 'draft_created',
          scheduled ? 'Post scheduled and waiting for due time' : 'Draft payload created in panel'
        ),
      ],
      attempts: 0,
      created_by: createdBy ?? null,
      operator_id: operatorId ?? null,
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

async function executeLinkedInApiFlow(job: any, connector: SocialConnectorCapability, input: SocialPostInput, userId?: string | null, operatorId?: string | null) {
  const timeline = Array.isArray(job.timeline) ? [...job.timeline] : [];
  timeline.push(makeEvent('AUTH_CHECK', 'approval_pending', 'Checking LinkedIn OAuth credentials'));

  const conn = await getOperatorPlatformConnection('linkedin', userId, operatorId);
  if (!conn) {
    timeline.push(makeEvent('PUBLISH', 'manual_action_required', 'LinkedIn not connected, manual fallback generated'));
    const fallback = manualFallback(connector, input);
    return patchJob(job.id, {
      status: 'manual_action_required',
      phase: 'PUBLISH',
      manual_task: fallback.manual_task ?? null,
      timeline,
    });
  }

  try {
    timeline.push(makeEvent('PAYLOAD_BUILD', 'approval_pending', 'LinkedIn payload prepared (text + link)'));
    timeline.push(makeEvent('API_SUBMIT', 'approval_pending', 'Submitting post to LinkedIn API'));

    const result = await publishLinkedInTextLink(conn as any, {
      content: input.content,
      cta_url: input.cta_url,
    });

    timeline.push(makeEvent('API_CONFIRMED', 'published', 'LinkedIn API confirmed post creation'));
    const published = publishedResult(result);
    return patchJob(job.id, {
      status: 'published',
      phase: 'PUBLISH',
      external_post_id: published.external_post_id ?? null,
      external_post_url: published.external_post_url ?? null,
      timeline,
      error_code: null,
      error_message: null,
    });
  } catch (err: unknown) {
    const norm = normalizeProviderError(err);
    timeline.push(makeEvent('PUBLISH', 'failed', norm.message, norm.code));
    await markConnectionFailure('linkedin', userId, operatorId, norm.message);

    if (norm.retryable) {
      return patchJob(job.id, {
        status: 'failed',
        phase: 'PUBLISH',
        error_code: norm.code,
        error_message: norm.message,
        provider_error_code: norm.code,
        provider_error_message: norm.message,
        timeline,
      });
    }

    return patchJob(job.id, {
      status: 'failed',
      phase: 'PUBLISH',
      error_code: norm.code,
      error_message: norm.message,
      provider_error_code: norm.code,
      provider_error_message: norm.message,
      timeline,
    });
  }
}

async function executeFlow(job: any, connector: SocialConnectorCapability, input: SocialPostInput, userId?: string | null, operatorId?: string | null) {
  const timeline = Array.isArray(job.timeline) ? [...job.timeline] : [];
  const validationErrors = validateSocialPostInput(input).filter((error) => {
    return !(isDueSchedule(input) && error === 'scheduled_at must be in the future');
  });

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

  if (connector.code === 'linkedin') {
    return executeLinkedInApiFlow(job, connector, input, userId, operatorId);
  }

  const fallback = manualFallback(connector, input);
  timeline.push(makeEvent('PUBLISH', 'manual_action_required', 'Manual-assisted publish task generated'));
  return patchJob(job.id, {
    status: 'manual_action_required',
    phase: 'PUBLISH',
    manual_task: fallback.manual_task ?? null,
    timeline,
  });
}

export async function createSocialPublishJobs(input: CreateSocialPublishRequestInput, userId?: string | null, operatorId?: string | null) {
  const targets = Array.from(new Set((input.targets ?? []).map((t) => String(t).trim().toLowerCase()).filter(Boolean))) as SocialPlatformCode[];
  if (targets.length === 0) throw new Error('At least one target platform is required');

  const connectorMap = await assertSocialTargetsReady(targets, userId, operatorId);
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

  const jobs: any[] = [];
  for (const target of targets) {
    const connector = connectorMap.get(target)!;
    const created = await createJob(request.id, connector, input.post_input, userId, operatorId);
    if (isFutureSchedule(input.post_input)) {
      jobs.push(created);
    } else {
      const executed = await executeFlow(created, connector, input.post_input, userId, operatorId);
      jobs.push(executed);
    }
  }

  return {
    request_id: request.id,
    idempotency_key: request.idempotency_key,
    jobs,
  };
}

export async function listSocialPublishJobs(params: {
  userId?: string | null;
  operatorId?: string | null;
  role?: string | null;
  limit?: number;
}) {
  const role = String(params.role ?? '').toLowerCase();
  const isAdmin = role === 'admin' || role === 'superadmin';
  const limit = Math.min(Math.max(Number(params.limit ?? 200), 1), 500);

  if (isAdmin && !params.operatorId) return [];

  let query = supabase
    .from('social_publish_jobs')
    .select('*, social_publish_requests(*)')
    .order('scheduled_at', { ascending: true, nullsFirst: false })
    .order('created_at', { ascending: false })
    .limit(limit);

  if (isAdmin) {
    query = query.eq('operator_id', params.operatorId);
  } else {
    query = query.eq('created_by', params.userId ?? '');
    if (params.operatorId) query = query.eq('operator_id', params.operatorId);
  }

  const { data, error } = await query;
  if (error) throw error;
  return data ?? [];
}

export async function updateSocialPublishRequestJobs(params: {
  requestId: string;
  input: CreateSocialPublishRequestInput;
  userId?: string | null;
  operatorId?: string | null;
  role?: string | null;
}) {
  const targets = Array.from(new Set((params.input.targets ?? []).map((t) => String(t).trim().toLowerCase()).filter(Boolean))) as SocialPlatformCode[];
  if (targets.length === 0) throw new Error('At least one target platform is required');

  const validationErrors = validateSocialPostInput(params.input.post_input);
  if (validationErrors.length > 0) throw new Error(validationErrors.join('; '));

  const role = String(params.role ?? '').toLowerCase();
  const isAdmin = role === 'admin' || role === 'superadmin';
  if (isAdmin && !params.operatorId) throw new Error('operator_id is required for admin scheduling');
  let requestQuery = supabase
    .from('social_publish_requests')
    .select('*')
    .eq('id', params.requestId);
  if (isAdmin) {
    if (params.operatorId) requestQuery = requestQuery.eq('operator_id', params.operatorId);
  } else {
    requestQuery = requestQuery.eq('created_by', params.userId ?? '');
  }

  const { data: request, error: requestError } = await requestQuery.maybeSingle();
  if (requestError && requestError.code !== 'PGRST116') throw requestError;
  if (!request) throw new Error('Social publish request not found');

  const { data: existingJobs, error: jobsError } = await supabase
    .from('social_publish_jobs')
    .select('*')
    .eq('request_id', params.requestId);
  if (jobsError) throw jobsError;

  const jobs = existingJobs ?? [];
  const locked = jobs.filter((job: any) => !canEditJobStatus(job.status));
  if (locked.length > 0) throw new Error('Published jobs cannot be edited');

  const operatorId = params.operatorId ?? request.operator_id ?? null;
  const connectorMap = await assertSocialTargetsReady(targets, params.userId, operatorId);
  const requestPatch = await supabase
    .from('social_publish_requests')
    .update({
      post_input: params.input.post_input,
      targets,
      operator_id: operatorId,
      updated_at: nowIso(),
    })
    .eq('id', params.requestId)
    .select('*')
    .single();
  if (requestPatch.error) throw requestPatch.error;

  const existingByPlatform = new Map(jobs.map((job: any) => [String(job.platform_code), job]));
  const targetSet = new Set<string>(targets);
  const out: any[] = [];

  for (const job of jobs) {
    if (targetSet.has(String(job.platform_code))) continue;
    const timeline = Array.isArray(job.timeline) ? [...job.timeline] : [];
    timeline.push(makeEvent('PUBLISH', 'manual_action_required', 'Platform removed from scheduled calendar entry'));
    const patched = await patchJob(job.id, {
      status: 'manual_action_required',
      phase: 'PUBLISH',
      manual_task: null,
      timeline,
    });
    out.push(patched);
  }

  for (const target of targets) {
    const connector = connectorMap.get(target)!;
    const existing = existingByPlatform.get(target);
    if (existing) {
      const timeline = Array.isArray((existing as any).timeline) ? [...(existing as any).timeline] : [];
      timeline.push(makeEvent('APPROVAL_PENDING', 'scheduled', 'Scheduled calendar entry updated'));
      const patched = await patchJob((existing as any).id, {
        status: isFutureSchedule(params.input.post_input) ? 'scheduled' : 'draft_created',
        phase: isFutureSchedule(params.input.post_input) ? 'APPROVAL_PENDING' : 'DRAFT_CREATE',
        post_input: params.input.post_input,
        scheduled_at: params.input.post_input.scheduled_at ?? null,
        operator_id: operatorId,
        error_code: null,
        error_message: null,
        provider_error_code: null,
        provider_error_message: null,
        validation_errors: null,
        timeline,
      });
      out.push(isFutureSchedule(params.input.post_input) ? patched : await executeFlow(patched, connector, params.input.post_input, params.userId, operatorId));
    } else {
      const created = await createJob(params.requestId, connector, params.input.post_input, params.userId, operatorId);
      out.push(isFutureSchedule(params.input.post_input) ? created : await executeFlow(created, connector, params.input.post_input, params.userId, operatorId));
    }
  }

  return {
    request_id: params.requestId,
    jobs: out,
  };
}

export async function processDueSocialPublishJobs(limit = 25) {
  const now = nowIso();
  const { data, error } = await supabase
    .from('social_publish_jobs')
    .select('*, social_publish_requests(*)')
    .eq('status', 'scheduled')
    .lte('scheduled_at', now)
    .order('scheduled_at', { ascending: true })
    .limit(Math.min(Math.max(Number(limit || 25), 1), 100));

  if (error) throw error;

  const processed: any[] = [];
  for (const job of data ?? []) {
    if (terminalJobStatus(job.status)) continue;
    const claimed = await patchJob(job.id, {
      status: 'draft_created',
      phase: 'DRAFT_CREATE',
      attempts: Number(job.attempts ?? 0) + 1,
      timeline: [
        ...(Array.isArray(job.timeline) ? job.timeline : []),
        makeEvent('DRAFT_CREATE', 'draft_created', 'Due scheduled job claimed by social publish runner'),
      ],
    });

    const { data: connector, error: connectorError } = await supabase
      .from('social_connectors')
      .select('*')
      .eq('code', claimed.platform_code)
      .single();
    if (connectorError) throw connectorError;

    const request = (job as any).social_publish_requests ?? {};
    const executed = await executeFlow(
      claimed,
      connector as SocialConnectorCapability,
      claimed.post_input as SocialPostInput,
      claimed.created_by as string | null,
      claimed.operator_id ?? request.operator_id ?? null
    );
    processed.push(executed);
  }

  return {
    processed: processed.length,
    jobs: processed,
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
    provider_error_code: null,
    provider_error_message: null,
  });

  return executeFlow(
    patched,
    connector as SocialConnectorCapability,
    job.post_input as SocialPostInput,
    job.created_by as string | null,
    (job as any).operator_id ?? null
  );
}
