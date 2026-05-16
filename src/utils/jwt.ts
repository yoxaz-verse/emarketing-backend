import jwt from 'jsonwebtoken';

const FALLBACK_DEV_SECRET = 'obaol-jwt-secret-2025';
const envSecret = String(process.env.JWT_SECRET ?? '').trim();
const isProduction = process.env.NODE_ENV === 'production';

if (isProduction && !envSecret) {
  throw new Error('JWT_SECRET is missing in production environment');
}

export const JWT_SECRET = envSecret || FALLBACK_DEV_SECRET;

if (!envSecret) {
  console.warn('[JWT_CONFIG_WARN] JWT_SECRET not set; using fallback development secret');
}

export function signToken(payload: string | object | Buffer) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '12h' });
}

export function verifyToken(token: string) {
  return jwt.verify(token, JWT_SECRET);
}
