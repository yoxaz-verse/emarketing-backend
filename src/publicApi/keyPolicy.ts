import { hasModuleAccess } from '../auth/moduleAccess';

export const API_SCOPES = ['leads:read', 'leads:write', 'campaigns:read', 'campaigns:write', 'campaigns:control', 'sequences:read', 'reports:read'] as const;
export type ApiScope = typeof API_SCOPES[number];
export type ApiContext = { keyId: string; userId: string; operatorId: string; role: string; scopes: ApiScope[] };

export function allowedScopes(role: string, accessFlags: unknown): ApiScope[] {
  const marketing = hasModuleAccess(role, accessFlags, 'marketing');
  const canWrite = ['user', 'admin', 'superadmin'].includes(role);
  return API_SCOPES.filter((scope) => {
    if (!marketing) return false;
    if (scope.endsWith(':read')) return true;
    return canWrite;
  });
}

export function evaluateApiKey(key: any, owner: any, now = Date.now()): { context?: ApiContext; code?: string } {
  if (!key || !key.active || key.revoked_at || !Array.isArray(key.scopes) ||
      (key.expires_at && Date.parse(key.expires_at) <= now)) return { code: 'INVALID_API_KEY' };
  if (!owner?.active || !key.operator_id || (owner.operator_id && owner.operator_id !== key.operator_id)) {
    return { code: 'KEY_OWNER_INACTIVE' };
  }
  const scopes = (key.scopes as string[]).filter((scope): scope is ApiScope =>
    (API_SCOPES as readonly string[]).includes(scope) && allowedScopes(owner.role, owner.access_flags).includes(scope as ApiScope));
  return { context: { keyId: key.id, userId: owner.id, operatorId: key.operator_id, role: owner.role, scopes } };
}
