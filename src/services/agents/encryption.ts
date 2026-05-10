import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

const ALGO = 'aes-256-gcm';

function getKeyBuffer() {
  const rawKey = process.env.AGENT_SECRET_KEY;
  if (!rawKey || rawKey.trim() === '') {
    throw new Error('AGENT_SECRET_KEY is missing. Set it in Backend/.env before using agent secrets.');
  }

  return createHash('sha256').update(rawKey).digest();
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const key = getKeyBuffer();
  const cipher = createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return `${iv.toString('base64')}.${tag.toString('base64')}.${encrypted.toString('base64')}`;
}

export function decryptSecret(encryptedBundle: string): string {
  const [ivB64, tagB64, cipherB64] = encryptedBundle.split('.');
  if (!ivB64 || !tagB64 || !cipherB64) {
    throw new Error('Invalid encrypted secret format.');
  }

  const key = getKeyBuffer();
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const encrypted = Buffer.from(cipherB64, 'base64');

  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);

  return decrypted.toString('utf8');
}
