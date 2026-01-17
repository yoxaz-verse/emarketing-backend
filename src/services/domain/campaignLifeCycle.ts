import { supabase } from '../../supabase';

/**
 * Campaign lifecycle hook
 *
 * IMPORTANT:
 * - This hook MUST NOT contain campaign start logic.
 * - Campaign start is handled exclusively by `startCampaign`.
 * - This hook only enforces CRUD-level invariants.
 */
export async function handleCampaignBeforeWrite(
  payload: Record<string, any>,
  mode: 'create' | 'update'
) {
  // ------------------------
  // CREATE
  // ------------------------
  if (mode === 'create') {
    if (!payload.operator_id) {
      throw new Error('operator_id is required for campaign');
    }

    if (!payload.sequence_id) {
      throw new Error('sequence_id is required for campaign');
    }

    // Default status
    if (!payload.status) {
      payload.status = 'draft';
    }

    return payload;
  }

  // ------------------------
  // UPDATE
  // ------------------------
  if (mode === 'update') {
    /**
     * DO NOT validate campaign start here.
     *
     * Why:
     * - updateRow is used internally by startCampaign
     * - lifecycle does not receive campaignId
     * - start validation belongs to domain action
     *
     * Allowed updates here:
     * - name
     * - paused_reason
     * - metadata changes
     * - status updates triggered by domain actions
     */
    return payload;
  }

  return payload;
}
