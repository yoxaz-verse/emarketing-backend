import { Request } from 'express';
import { Role } from '../auth/roles';

/**
 * Resolves operator scope
 * - operator → returns operator_id (required)
 * - admin / superadmin → returns null (global scope)
 */
export function resolveOperatorScope(
  req: Request
): string | null {
  const auth = req.auth;

  if (!auth) {
    throw new Error('Unauthenticated');
  }

  // Operator: fixed scope
  if (auth.role === 'operator') {
    if (!auth.operator_id) {
      throw new Error('Operator ID missing');
    }
    return auth.operator_id;
  }

  // Admin / Superadmin: global scope
  if (auth.role === 'admin' || auth.role === 'superadmin') {
    return null;
  }

  throw new Error('Forbidden');
}
