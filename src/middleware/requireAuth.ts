import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { supabase } from '../supabase.js';
import { verifyToken } from '../utils/jwt';
import { Role, hasPermission } from '../auth/roles.js';

type JwtPayload = {
  user_id: string;
  role: Role;
  operator_id?: string | null;
};

function extractCookieToken(cookieHeader?: string): string {
  if (!cookieHeader) return '';
  const cookieMap = Object.fromEntries(
    cookieHeader
      .split(';')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const [key, ...rest] = entry.split('=');
        return [key, rest.join('=')];
      })
  );
  return String(cookieMap.auth_token ?? '').trim();
}

export function requireAuth(
  minimumRole?: Role,
  requireOperator: boolean = false
) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      console.log('[AUTH_REQUIRE] Start');

      const authHeader = req.headers.authorization;
      const apiKeyHeader = req.headers['x-api-key'];
      const cookieToken = extractCookieToken(req.headers.cookie);

      const hasJwt =
        typeof authHeader === 'string' &&
        authHeader.startsWith('Bearer ');
      const hasCookieJwt = Boolean(cookieToken);

      const hasApiKey = typeof apiKeyHeader === 'string';

      /* ======================================================
         0️⃣ MUTUAL EXCLUSION (IMPORTANT)
         JWT OR API KEY — NEVER BOTH
      ====================================================== */
      if ((hasJwt || hasCookieJwt) && hasApiKey) {
        console.warn('[AUTH_REJECT] Both JWT and API key provided');
        return res.status(400).json({
          error: 'Use either JWT or API key, not both',
        });
      }

      /* ======================================================
         1️⃣ JWT AUTH (USER CONTEXT)
      ====================================================== */
      if (hasJwt || hasCookieJwt) {
        const token = hasJwt ? authHeader!.slice(7).trim() : cookieToken;
        const tokenSource = hasJwt ? 'authorization_header' : 'cookie_auth_token';
      
        let jwtUser: JwtPayload;
        try {
          jwtUser = verifyToken(token) as JwtPayload;
        } catch (err) {
          console.warn('[AUTH_REJECT] Invalid JWT token', { tokenSource, error: (err as Error)?.message ?? 'unknown' });
          return res.status(401).json({ error: 'Invalid token' });
        }
      
        const { data: dbUser, error } = await supabase
          .from('users')
          .select('id, role, operator_id, active')
          .eq('id', jwtUser.user_id)
          .maybeSingle();
      
        // ✅ USER NOT YET CREATED IN DB — ALLOW
        if (!dbUser) {
          console.info('[AUTH_ALLOW] JWT user not yet provisioned in users table', { tokenSource, userId: jwtUser.user_id });
          req.auth = {
            type: 'user',
            user_id: jwtUser.user_id,
            role: jwtUser.role,
            operator_id: null,
          };
          return next();
        }
      
        if (!dbUser.active) {
          console.warn('[AUTH_REJECT] Inactive user', { tokenSource, userId: dbUser.id });
          return res.status(401).json({
            error: 'User disabled',
          });
        }
      
        if (minimumRole && !hasPermission(dbUser.role, minimumRole)) {
          console.warn('[AUTH_REJECT] Insufficient permissions', {
            tokenSource,
            userId: dbUser.id,
            actualRole: dbUser.role,
            requiredRole: minimumRole,
          });
          return res.status(403).json({
            error: 'Insufficient permissions',
          });
        }
      
        if (requireOperator && !dbUser.operator_id) {
          console.warn('[AUTH_REJECT] Operator access required', { tokenSource, userId: dbUser.id });
          return res.status(403).json({
            error: 'Operator access required',
          });
        }
      
        req.auth = {
          type: 'user',
          user_id: dbUser.id,
          role: dbUser.role,
          operator_id: dbUser.operator_id ?? null,
        };

        console.info('[AUTH_ALLOW] JWT auth accepted', { tokenSource, userId: dbUser.id, role: dbUser.role });
        return next();
      }
      
      /* ======================================================
         6️⃣ API KEY AUTH (ENGINE / AUTOMATION)
      ====================================================== */
      if (hasApiKey) {
        const keyHash = crypto
          .createHash('sha256')
          .update(apiKeyHeader as string)
          .digest('hex');

        const { data: key, error } = await supabase
          .from('api_keys')
          .select('id, user_id, operator_id, role, active')
          .eq('key_hash', keyHash)
          .single();

        if (error || !key || !key.active) {
          console.warn('[AUTH_REJECT] Invalid or inactive API key');
          return res.status(403).json({
            error: 'Invalid or inactive API key',
          });
        }

        /* ======================================================
           7️⃣ ROLE PERMISSION CHECK (API KEY)
        ====================================================== */
        if (minimumRole && !hasPermission(key.role as Role, minimumRole)) {
          console.warn('[AUTH_REJECT] API key insufficient permissions', {
            actualRole: key.role,
            requiredRole: minimumRole,
          });
          return res.status(403).json({
            error: 'Insufficient permissions',
            required: minimumRole,
            actual: key.role,
          });
        }

        /* ======================================================
           8️⃣ OPERATOR CAPABILITY CHECK
        ====================================================== */
        if (requireOperator && !key.operator_id) {
          console.warn('[AUTH_REJECT] API key missing operator');
          return res.status(403).json({
            error: 'Operator access required',
          });
        }

        /* ======================================================
           9️⃣ AUDIT: LAST USED
        ====================================================== */
        await supabase
          .from('api_keys')
          .update({ last_used_at: new Date().toISOString() })
          .eq('id', key.id);

        /* ======================================================
           🔟 ATTACH AUTH CONTEXT (API)
        ====================================================== */
        req.auth = {
          type: 'api',
          api_key_id: key.id,
          user_id: key.user_id,
          role: key.role as Role,
          operator_id: key.operator_id,
        };

        console.info('[AUTH_ALLOW] API key accepted', { keyId: key.id, role: key.role });
        return next();
      }

      /* ======================================================
         ❌ NO AUTH PROVIDED
      ====================================================== */
      console.warn('[AUTH_REJECT] No authentication provided');
      return res.status(401).json({
        error: 'Authentication required',
      });
    } catch (err) {
      console.error('[AUTH ERROR]', err);
      return res.status(401).json({
        error: 'Authentication failed',
      });
    }
  };
}
