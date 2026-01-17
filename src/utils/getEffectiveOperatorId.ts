import type { Request } from 'express';
import { resolveOperatorScope } from './resolveOperatorId';

export function getEffectiveOperatorId(req: Request): string {
  const scopedOperatorId = resolveOperatorScope(req);

  // Operator flow → already scoped
  if (scopedOperatorId) {
    return scopedOperatorId;
  }

  // Admin flow → read from body or query
  const body = req.body as { operator_id?: string } | undefined;
  const query = req.query as { operator_id?: string } | undefined;

  const operatorId =
    body?.operator_id ||
    query?.operator_id;

  if (!operatorId) {
    throw new Error('operator_id is required for admin action');
  }

  return operatorId;
}
