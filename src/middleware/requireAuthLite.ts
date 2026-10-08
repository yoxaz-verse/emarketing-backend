import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { Role } from '../auth/roles';
import { JWT_SECRET } from '../utils/jwt';
import { normalizeModuleAccessFlags } from '../auth/moduleAccess';
import { userAuthorizationCache } from '../auth/userAuthorizationCache';
import { formatUnknownError, isSupabaseAuthConfigError } from '../utils/errorFormat';

type JwtPayload = {
  user_id: string;
  role: Role;
  operator_id?: string | null;
  access_flags?: Record<string, boolean>;
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
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
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

    let payload: JwtPayload;
    try {
      payload = jwt.verify(
        token,
        JWT_SECRET
      ) as JwtPayload;
    } catch (err) {
      console.log('[requireAuthLite] Token verification failed:', {
        tokenSource,
        message: err instanceof Error ? err.message : 'unknown',
        ...authMeta(req),
      });
      res.status(401).json({ error: 'UNAUTHORIZED' });
      return;
    }

    if (!payload.user_id || !payload.role) {
      res.status(401).json({ error: 'UNAUTHORIZED' });
      return;
    }

    try {
      const user = await userAuthorizationCache.get(payload.user_id);
      if (!user || user.active !== true) {
        res.status(401).json({ error: 'UNAUTHORIZED' });
        return;
      }

      // ✅ MAP PAYLOAD → req.auth (IMPORTANT)
      req.auth = {
        type: 'user',
        role: user.role,
        user_id: user.id,
        operator_id: user.operator_id ?? null,
        access_flags: normalizeModuleAccessFlags(user.access_flags, user.role),
        email: user.email ?? null,
      };

      next();
    } catch (err) {
      console.error('[requireAuthLite] User authorization lookup failed:', {
        tokenSource,
        userId: payload.user_id,
        error: formatUnknownError(err),
        ...authMeta(req),
      });
      const misconfigured = isSupabaseAuthConfigError(err);
      res.status(503).json({
        error: misconfigured ? 'Authentication service is misconfigured' : 'Authentication service unavailable',
        code: misconfigured ? 'AUTH_SERVICE_MISCONFIGURED' : 'AUTH_SERVICE_UNAVAILABLE',
      });
    }
  };
}
