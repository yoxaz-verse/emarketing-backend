import crypto from 'crypto';
import Redis from 'ioredis';
import type { Request, Response, NextFunction } from 'express';
import { supabase } from '../supabase';
import { evaluateApiKey, type ApiContext, type ApiScope } from './keyPolicy';
export { API_SCOPES, allowedScopes } from './keyPolicy';
export type { ApiScope, ApiContext } from './keyPolicy';

declare global {
  namespace Express { interface Request { publicApi?: ApiContext; requestId?: string } }
}

export function apiError(res: Response, status: number, code: string, message: string, details?: unknown) {
  return res.status(status).json({ error: { code, message, ...(details === undefined ? {} : { details }) }, request_id: res.req.requestId });
}

export function requestId(req: Request, res: Response, next: NextFunction) {
  req.requestId = crypto.randomUUID();
  res.setHeader('X-Request-Id', req.requestId);
  res.setHeader('Cache-Control', 'no-store');
  next();
}

const localBuckets = new Map<string, { count: number; reset: number }>();
let redisClient: Redis | null | undefined;
function getRedis() {
  if (redisClient !== undefined) return redisClient;
  redisClient = process.env.REDIS_URL ? new Redis(process.env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1, connectTimeout: 1000 }) : null;
  redisClient?.on('error', () => undefined);
  return redisClient;
}
export async function authenticateApi(req: Request, res: Response, next: NextFunction) {
  if (req.headers.authorization) return apiError(res, 400, 'AUTH_SCHEME', 'Use only X-API-Key for /v1.');
  const raw = req.header('X-API-Key')?.trim() ?? '';
  if (!/^obaol_live_[a-f0-9]{64}$/.test(raw)) return apiError(res, 401, 'INVALID_API_KEY', 'A valid X-API-Key is required.');
  try {
    const hash = crypto.createHash('sha256').update(raw).digest('hex');
    const { data: key, error } = await supabase.from('api_keys')
      .select('id,user_id,operator_id,active,scopes,expires_at,revoked_at')
      .eq('key_hash', hash).maybeSingle();
    if (error) throw error;
    if (!key || !key.active || key.revoked_at || !Array.isArray(key.scopes) ||
        (key.expires_at && Date.parse(key.expires_at) <= Date.now())) {
      return apiError(res, 401, 'INVALID_API_KEY', 'API key is invalid, expired, or revoked.');
    }
    const { data: owner, error: ownerError } = await supabase.from('users')
      .select('id,role,operator_id,access_flags,active').eq('id', key.user_id).maybeSingle();
    if (ownerError) throw ownerError;
    const verdict = evaluateApiKey(key, owner);
    if (!verdict.context) {
      return apiError(res, 403, 'KEY_OWNER_INACTIVE', 'Key owner or operator is no longer available.');
    }
    req.publicApi = verdict.context;

    const max = Math.max(1, Number(process.env.PUBLIC_API_RATE_LIMIT_PER_MINUTE) || 120);
    const windowStart = Math.floor(Date.now() / 60_000) * 60_000;
    const bucketKey = `${key.id}:${windowStart}`;
    let count: number;
    const redis = getRedis();
    if (redis) {
      try {
        if (redis.status === 'wait') await redis.connect();
        count = await redis.incr(`obaol:v1:rate:${bucketKey}`);
        if (count === 1) await redis.pexpire(`obaol:v1:rate:${bucketKey}`, 60_000);
      } catch {
        const bucket = localBuckets.get(bucketKey) ?? { count: 0, reset: windowStart + 60_000 };
        count = ++bucket.count;
        localBuckets.set(bucketKey, bucket);
      }
    } else {
      const bucket = localBuckets.get(bucketKey) ?? { count: 0, reset: windowStart + 60_000 };
      count = ++bucket.count;
      localBuckets.set(bucketKey, bucket);
    }
    if (localBuckets.size > 2000) for (const [id, bucket] of localBuckets) if (bucket.reset < Date.now()) localBuckets.delete(id);
    res.setHeader('RateLimit-Limit', String(max));
    res.setHeader('RateLimit-Remaining', String(Math.max(0, max - count)));
    res.setHeader('RateLimit-Reset', String(Math.max(0, Math.ceil((windowStart + 60_000 - Date.now()) / 1000))));
    if (count > max) {
      res.setHeader('Retry-After', String(Math.ceil((windowStart + 60_000 - Date.now()) / 1000)));
      return apiError(res, 429, 'RATE_LIMITED', 'API rate limit exceeded.');
    }
    const { error: usageError } = await supabase.from('api_keys').update({ last_used_at: new Date().toISOString() }).eq('id', key.id);
    if (usageError) throw usageError;
    next();
  } catch (error) {
    console.error('[PUBLIC_API_AUTH_ERROR]', error instanceof Error ? error.message : 'unknown');
    return apiError(res, 503, 'AUTH_UNAVAILABLE', 'API authentication is temporarily unavailable.');
  }
}

export function requireScope(scope: ApiScope) {
  return (req: Request, res: Response, next: NextFunction) =>
    req.publicApi?.scopes.includes(scope) ? next() : apiError(res, 403, 'SCOPE_REQUIRED', `This operation requires ${scope}.`);
}

export function pageInput(req: Request) {
  const page = Number(req.query.page ?? 1);
  const pageSize = Number(req.query.page_size ?? 25);
  if (!Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    throw Object.assign(new Error('page must be positive and page_size must be 1–100.'), { status: 400, code: 'INVALID_PAGINATION' });
  }
  return { page, pageSize, from: (page - 1) * pageSize, to: page * pageSize - 1 };
}

export function fail(res: Response, error: any) {
  const pgStatus: Record<string, number> = { '23505': 409, '23503': 409, '23502': 400, '22P02': 400 };
  const status = Number(error?.status ?? error?.statusCode ?? pgStatus[String(error?.code ?? '')] ?? 500);
  const safeStatus = status >= 400 && status < 600 ? status : 500;
  if (safeStatus >= 500) console.error('[PUBLIC_API_ERROR]', error?.message ?? error);
  const code = /^[0-9A-Z_]+$/.test(String(error?.code ?? '')) ? error.code : safeStatus === 409 ? 'CONFLICT' : safeStatus >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_FAILED';
  return apiError(res, safeStatus, code, safeStatus >= 500 ? 'The request could not be completed.' : String(error?.message ?? 'Request failed.'));
}

export function badRequest(message: string): never {
  throw Object.assign(new Error(message), { status: 400, code: 'INVALID_REQUEST' });
}

export function dto(body: unknown, allowed: readonly string[], required: readonly string[] = []) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) badRequest('A JSON object is required.');
  const input = body as Record<string, unknown>;
  for (const key of Object.keys(input)) if (!allowed.includes(key)) badRequest(`Unknown field: ${key}`);
  for (const key of required) if (typeof input[key] !== 'string' || !String(input[key]).trim()) badRequest(`${key} is required.`);
  for (const [key, value] of Object.entries(input)) {
    if (key !== 'lead_ids' && value !== null && typeof value !== 'string') badRequest(`${key} must be a string.`);
  }
  return input;
}
