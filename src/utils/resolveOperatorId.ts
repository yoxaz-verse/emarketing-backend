import { Request } from 'express';

/**
 * Resolves operator scope
 * - non-admin users with operator_id → returns operator_id (scoped)
 * - admin / superadmin → returns null (global scope)
 */
export function resolveOperatorScope(
  req: Request
): string | null {
  const auth = req.auth;

  if (!auth) {
    throw new Error('Unauthenticated');
  }

  const normalizedRole = String(auth.role ?? '').toLowerCase();

  // Admin / Superadmin: global scope
  if (normalizedRole === 'admin' || normalizedRole === 'superadmin') {
    return null;
  }

  // Non-admin role with operator scope
  if (auth.operator_id) {
    return auth.operator_id;
  }

  // Any non-admin role without operator scope cannot use operator-scoped routes
  if (normalizedRole === 'user' || normalizedRole === 'viewer') {
    throw new Error('Operator access required');
  }

  // Backward-compat: legacy role strings still supported if present in old tokens
  if (normalizedRole === 'operator') {
    if (!auth.operator_id) {
      throw new Error('Operator ID missing');
    }
    return auth.operator_id;
  }

  throw new Error('Forbidden');
}
