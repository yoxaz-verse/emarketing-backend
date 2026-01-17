import jwt from 'jsonwebtoken';

export const JWT_SECRET = process.env.JWT_SECRET as string || "obaol-jwt-secret-2025";

if (!JWT_SECRET) {
  throw new Error('JWT_SECRET is missing in environment');
}

export function signToken(payload: any) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '12h' });
}

export function verifyToken(token: string) {
  return jwt.verify(token, JWT_SECRET);
}
