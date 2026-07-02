import crypto from 'crypto';
import type { NextFunction, Request, Response } from 'express';
import Redis from 'ioredis';

type Bucket = { count: number; resetAt: number };
const buckets = new Map<string, Bucket>();
const seenSignatures = new Map<string, number>();
let redisClient: Redis | null | undefined;

function getRedis() {
  if (redisClient !== undefined) return redisClient;
  const url = String(process.env.REDIS_URL ?? '').trim();
  redisClient = url ? new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1, connectTimeout: 1000 }) : null;
  redisClient?.on('error', () => undefined);
  return redisClient;
}

export function securityHeaders(_req: Request, res: Response, next: NextFunction) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
  next();
}

export function rateLimit(options: { windowMs: number; max: number; name: string }) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    const key = `${options.name}:${req.ip || req.socket.remoteAddress || 'unknown'}`;
    const redis = getRedis();
    if (redis) {
      try {
        if (redis.status === 'wait') await redis.connect();
        const redisKey = `obaol:rate:${key}`;
        const count = await redis.incr(redisKey);
        if (count === 1) await redis.pexpire(redisKey, options.windowMs);
        const ttl = Math.max(0, await redis.pttl(redisKey));
        res.setHeader('RateLimit-Limit', String(options.max));
        res.setHeader('RateLimit-Remaining', String(Math.max(0, options.max - count)));
        res.setHeader('RateLimit-Reset', String(Math.ceil((now + ttl) / 1000)));
        if (count > options.max) {
          res.setHeader('Retry-After', String(Math.max(1, Math.ceil(ttl / 1000))));
          return res.status(429).json({ error: 'Too many requests. Please try again later.' });
        }
        return next();
      } catch {
        // Continue with the local limiter if Redis is temporarily unavailable.
      }
    }
    const current = buckets.get(key);
    const bucket = !current || current.resetAt <= now
      ? { count: 0, resetAt: now + options.windowMs }
      : current;
    bucket.count += 1;
    buckets.set(key, bucket);
    res.setHeader('RateLimit-Limit', String(options.max));
    res.setHeader('RateLimit-Remaining', String(Math.max(0, options.max - bucket.count)));
    res.setHeader('RateLimit-Reset', String(Math.ceil(bucket.resetAt / 1000)));
    if (bucket.count > options.max) {
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))));
      return res.status(429).json({ error: 'Too many requests. Please try again later.' });
    }
    next();
  };
}

function timingSafeEqual(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function requireServiceSecret(envName = 'INTERNAL_SERVICE_SECRET') {
  return (req: Request, res: Response, next: NextFunction) => {
    const expected = String(process.env[envName] ?? '').trim();
    const provided = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '').trim();
    if (!expected) return res.status(503).json({ error: `${envName} is not configured` });
    if (!provided || !timingSafeEqual(provided, expected)) {
      return res.status(401).json({ error: 'Unauthorized service request' });
    }
    next();
  };
}

export function requireWebhookSignature(envName = 'OBAOL_WEBHOOK_SECRET') {
  return async (req: Request, res: Response, next: NextFunction) => {
    const secret = String(process.env[envName] ?? '').trim();
    if (!secret) return res.status(503).json({ error: `${envName} is not configured` });
    const timestamp = String(req.headers['x-obaol-timestamp'] ?? '').trim();
    const signature = String(req.headers['x-obaol-signature'] ?? '').replace(/^sha256=/i, '').trim();
    const timestampMs = Number(timestamp) * 1000;
    if (!timestamp || !signature || !Number.isFinite(timestampMs) || Math.abs(Date.now() - timestampMs) > 5 * 60_000) {
      return res.status(401).json({ error: 'Invalid or expired webhook signature' });
    }
    const replayKey = `${timestamp}:${signature}`;
    const rawBody = Buffer.isBuffer((req as Request & { rawBody?: Buffer }).rawBody)
      ? (req as Request & { rawBody: Buffer }).rawBody
      : Buffer.from(JSON.stringify(req.body ?? {}));
    const expected = crypto.createHmac('sha256', secret).update(timestamp).update('.').update(rawBody).digest('hex');
    if (!timingSafeEqual(signature, expected)) return res.status(401).json({ error: 'Invalid webhook signature' });
    const redis = getRedis();
    if (redis) {
      try {
        if (redis.status === 'wait') await redis.connect();
        const accepted = await redis.set(`obaol:webhook:${replayKey}`, '1', 'EX', 300, 'NX');
        if (accepted !== 'OK') return res.status(409).json({ error: 'Webhook replay rejected' });
        return next();
      } catch {
        // Continue with process-local replay protection during a Redis outage.
      }
    }
    const prior = seenSignatures.get(replayKey);
    if (prior && prior > Date.now()) return res.status(409).json({ error: 'Webhook replay rejected' });
    seenSignatures.set(replayKey, Date.now() + 5 * 60_000);
    for (const [key, expiresAt] of seenSignatures) if (expiresAt <= Date.now()) seenSignatures.delete(key);
    next();
  };
}

export function requireWriteRole(req: Request, res: Response, next: NextFunction) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const role = String(req.auth?.role ?? '').toLowerCase();
  if (!['user', 'admin', 'superadmin'].includes(role)) {
    return res.status(403).json({ error: 'Write access requires user role or higher' });
  }
  next();
}
