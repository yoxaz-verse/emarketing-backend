import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { Role } from '../auth/roles';
import { JWT_SECRET } from '../utils/jwt';

type JwtPayload = {
  user_id: string;
  role: Role;
  operator_id?: string | null;
};

export function requireAuthLite() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const authHeader = req.headers.authorization;
    console.log('[requireAuthLite] Auth Header:', authHeader);

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      console.log('[requireAuthLite] No Bearer token');
      res.status(401).json({ error: 'UNAUTHORIZED' });
      return;
    }

    const token = authHeader.slice(7);

    try {
      const payload = jwt.verify(
        token,
        JWT_SECRET
      ) as JwtPayload;

      console.log('[requireAuthLite] Payload:', JSON.stringify(payload));

      // ✅ MAP PAYLOAD → req.auth (IMPORTANT)
      req.auth = {
        type: 'user',
        role: payload.role,
        user_id: payload.user_id,
        operator_id: payload.operator_id ?? null,
      };

      console.log('[requireAuthLite] req.auth set:', JSON.stringify(req.auth));

      next();
    } catch (err) {
      console.log('[requireAuthLite] Token verification failed:', err);
      res.status(401).json({ error: 'UNAUTHORIZED' });
    }
  };
}
