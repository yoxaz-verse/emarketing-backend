import crypto from 'crypto';

const FALLBACK_KEY =
  '0000000000000000000000000000000000000000000000000000000000000000';

const RAW_KEY =
  typeof process !== 'undefined' && process.env.SOCIAL_INTEGRATION_SECRET_KEY
    ? process.env.SOCIAL_INTEGRATION_SECRET_KEY
    : FALLBACK_KEY;

const SAFE_KEY = RAW_KEY.length === 64 ? RAW_KEY : FALLBACK_KEY;
const ENCRYPTION_KEY = Buffer.from(SAFE_KEY, 'hex');
const IV = Buffer.alloc(16, 0);

export function encryptSocialSecret(value: string): string {
  if (!value) return value;

  const cipher = crypto.createCipheriv('aes-256-ctr', ENCRYPTION_KEY, IV);
  return Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]).toString('hex');
}

export function decryptSocialSecret(encrypted: string): string {
  if (!encrypted) return encrypted;

  const decipher = crypto.createDecipheriv('aes-256-ctr', ENCRYPTION_KEY, IV);
  return Buffer.concat([decipher.update(Buffer.from(encrypted, 'hex')), decipher.final()]).toString('utf8');
}
