import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { Role } from '../auth/roles';
import { JWT_SECRET } from '../utils/jwt';

type JwtPayload = {
  user_id: string;
  role: Role;
  operator_id?: string | null;
};

function authMeta(req: Request) {
  return {
    method: req.method,
    path: req.originalUrl || req.url,
    host: req.headers.host ?? 'unknown',
    deploymentVersion: process.env.DEPLOYMENT_VERSION ?? process.env.CAPROVER_GIT_COMMIT_SHA ?? 'unset',
  };
}

export function requireAuthLite() {
  return (req: Request, res: Response, next: NextFunction): void => {
    let token = '';
    let tokenSource: 'authorization_header' | 'cookie_auth_token' | 'none' = 'none';
    const authHeader = req.headers.authorization;

    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.slice(7);
      tokenSource = 'authorization_header';
    } else if (req.headers.cookie) {
      // ✅ Manual Parse Cookies (avoiding extra deps like cookie-parser)
      const cookies = Object.fromEntries(
        req.headers.cookie.split('; ').map((c) => {
          const [key, ...v] = c.split('=');
          return [key, v.join('=')];
        })
      );
      token = cookies['auth_token'];
      if (token) tokenSource = 'cookie_auth_token';
    }

    if (!token) {
      console.log('[requireAuthLite] No token found in header or cookies', { tokenSource, ...authMeta(req) });
      res.status(401).json({ error: 'UNAUTHORIZED' });
      return;
    }

    try {
      const payload = jwt.verify(
        token,
        JWT_SECRET
      ) as JwtPayload;

      console.log('[requireAuthLite] Payload:', JSON.stringify(payload), authMeta(req));

      // ✅ MAP PAYLOAD → req.auth (IMPORTANT)
      req.auth = {
        type: 'user',
        role: payload.role,
        user_id: payload.user_id,
        operator_id: payload.operator_id ?? null,
      };

      console.log('[requireAuthLite] req.auth set:', JSON.stringify(req.auth), authMeta(req));

      next();
    } catch (err) {
      console.log('[requireAuthLite] Token verification failed:', {
        tokenSource,
        message: err instanceof Error ? err.message : 'unknown',
        ...authMeta(req),
      });
      res.status(401).json({ error: 'UNAUTHORIZED' });
    }
  };
}
