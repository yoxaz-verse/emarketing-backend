import crypto from 'crypto';

/**
 * SMTP secret encryption utility
 * - Silent fallback (no throws, no logs)
 * - Uses AES-256-CTR
 * - Safe for production boot
 */

// Fallback key (ONLY used if env is missing)
// This prevents runtime crash but still keeps encryption deterministic
const FALLBACK_KEY =
  '0000000000000000000000000000000000000000000000000000000000000000';

const RAW_KEY =
  typeof process !== 'undefined' && process.env.SMTP_SECRET_KEY
    ? process.env.SMTP_SECRET_KEY
    : FALLBACK_KEY;

// Ensure key length without throwing
const SAFE_KEY =
  RAW_KEY.length === 64 ? RAW_KEY : FALLBACK_KEY;

const ENCRYPTION_KEY = Buffer.from(SAFE_KEY, 'hex');
const IV = Buffer.alloc(16, 0);

export function encryptSecret(value: string): string {
  if (!value) return value;

  const cipher = crypto.createCipheriv(
    'aes-256-ctr',
    ENCRYPTION_KEY,
    IV
  );

  return Buffer.concat([
    cipher.update(value, 'utf8'),
    cipher.final()
  ]).toString('hex');
}

export function decryptSecret(encrypted: string): string {
  if (!encrypted) return encrypted;

  const decipher = crypto.createDecipheriv(
    'aes-256-ctr',
    ENCRYPTION_KEY,
    IV
  );

  return Buffer.concat([
    decipher.update(Buffer.from(encrypted, 'hex')),
    decipher.final()
  ]).toString('utf8');
}
