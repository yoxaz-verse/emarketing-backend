import IORedis from 'ioredis';
import { logger } from '../logging/logger';

const CACHE_TTL_SECONDS = Number(process.env.EMAIL_VALIDATION_CACHE_TTL_SECONDS ?? 86400);

let redis: IORedis | null = null;

function getRedis(): IORedis | null {
  if (redis) return redis;
  const url = process.env.REDIS_URL;
  if (!url) return null;

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
  const client = getRedis();
  if (!client) return null;
  const raw = await client.get(key);
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
  const client = getRedis();
  if (!client) return;
  await client.set(key, JSON.stringify(value), 'EX', ttlSeconds);
}
