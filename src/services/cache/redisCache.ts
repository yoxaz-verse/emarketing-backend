import IORedis from 'ioredis';
import { logger } from '../logging/logger';

const CACHE_TTL_SECONDS = Number(process.env.EMAIL_VALIDATION_CACHE_TTL_SECONDS ?? 86400);
const CACHE_OP_TIMEOUT_MS = Math.max(100, Number(process.env.EMAIL_VALIDATION_CACHE_OP_TIMEOUT_MS ?? 800));
const CACHE_ENABLED = process.env.EMAIL_VALIDATION_CACHE_ENABLED !== 'false';
const CACHE_BREAKER_THRESHOLD = Math.max(1, Number(process.env.EMAIL_VALIDATION_CACHE_BREAKER_THRESHOLD ?? 3));
const CACHE_BREAKER_COOLDOWN_MS = Math.max(1_000, Number(process.env.EMAIL_VALIDATION_CACHE_BREAKER_COOLDOWN_MS ?? 30_000));

let redis: IORedis | null = null;
let consecutiveCacheFailures = 0;
let cacheBypassUntil = 0;
let cacheBypassLoggedAt = 0;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, timeoutLabel: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeoutId = setTimeout(() => reject(new Error(timeoutLabel)), timeoutMs);
    promise
      .then((value) => {
        clearTimeout(timeoutId);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timeoutId);
        reject(error);
      });
  });
}

function canUseCache(): boolean {
  if (!CACHE_ENABLED) return false;
  if (Date.now() < cacheBypassUntil) {
    const now = Date.now();
    if (now - cacheBypassLoggedAt > 10_000) {
      cacheBypassLoggedAt = now;
      logger.warn('cache_bypassed', {
        reason: 'circuit_open',
        bypassUntil: new Date(cacheBypassUntil).toISOString(),
        consecutiveFailures: consecutiveCacheFailures,
      });
    }
    return false;
  }
  return true;
}

function markCacheFailure(error: unknown, op: 'get' | 'set'): void {
  consecutiveCacheFailures += 1;
  const message = error instanceof Error ? error.message : String(error ?? 'unknown');
  logger.warn('cache_timeout', {
    op,
    timeoutMs: CACHE_OP_TIMEOUT_MS,
    error: message,
    consecutiveFailures: consecutiveCacheFailures,
  });

  if (consecutiveCacheFailures >= CACHE_BREAKER_THRESHOLD) {
    cacheBypassUntil = Date.now() + CACHE_BREAKER_COOLDOWN_MS;
    logger.warn('cache_bypassed', {
      reason: 'failure_threshold',
      bypassUntil: new Date(cacheBypassUntil).toISOString(),
      consecutiveFailures: consecutiveCacheFailures,
      threshold: CACHE_BREAKER_THRESHOLD,
    });
  }
}

function markCacheSuccess(): void {
  const hadFailures = consecutiveCacheFailures > 0 || cacheBypassUntil > 0;
  consecutiveCacheFailures = 0;
  cacheBypassUntil = 0;
  if (hadFailures) {
    logger.info('cache_recovered', {
      timeoutMs: CACHE_OP_TIMEOUT_MS,
    });
  }
}

function getRedis(): IORedis | null {
  if (redis) return redis;
  const url = process.env.REDIS_URL;
  if (!url || !CACHE_ENABLED) return null;

  redis = new IORedis(url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });

  redis.on('error', (err: Error) => {
    logger.warn('redis_cache_error', { error: err.message });
  });

  return redis;
}

export async function cacheGet<T>(key: string): Promise<T | null> {
  if (!canUseCache()) return null;
  const client = getRedis();
  if (!client) return null;
  let raw: string | null = null;
  try {
    raw = await withTimeout(
      client.get(key),
      CACHE_OP_TIMEOUT_MS,
      `cache_get_timeout_${CACHE_OP_TIMEOUT_MS}ms`
    );
    markCacheSuccess();
  } catch (error) {
    markCacheFailure(error, 'get');
    return null;
  }
  if (!raw) return null;

  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function cacheSet<T>(
  key: string,
  value: T,
  ttlSeconds: number = CACHE_TTL_SECONDS
): Promise<void> {
  if (!canUseCache()) return;
  const client = getRedis();
  if (!client) return;
  try {
    await withTimeout(
      client.set(key, JSON.stringify(value), 'EX', ttlSeconds),
      CACHE_OP_TIMEOUT_MS,
      `cache_set_timeout_${CACHE_OP_TIMEOUT_MS}ms`
    );
    markCacheSuccess();
  } catch (error) {
    markCacheFailure(error, 'set');
  }
}
