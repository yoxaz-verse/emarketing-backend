// src/services/lifecycle/leadLifeCycle.ts

import { supabase } from "../../supabase";

type WriteMode = 'create' | 'update';

export async function handleLeadsBeforeWrite(
  payload: Record<string, any>,
  mode: WriteMode
) {
  /**
   * CREATE MODE
   * New lead always starts as pending
   */
  if (mode === 'create') {
    if (payload.email) {
      payload.email_eligibility = 'pending';
      payload.email_eligibility_reason = null;
      payload.email_checked_at = null;
      payload.retry_count = 0;
      payload.permanently_failed = false;
      payload.eligibility_processing = false;
    }

    return payload;
  }

  /**
   * UPDATE MODE
   * Only reset eligibility if email is being changed
   */
  if (mode === 'update') {
    if (payload.email !== undefined) {
      payload.email_eligibility = 'pending';
      payload.email_eligibility_reason = null;
      payload.email_checked_at = null;
      payload.retry_count = 0;
      payload.permanently_failed = false;
      payload.eligibility_processing = false;
    }

    return payload;
  }

  return payload;
}



/**
 * READ-MODEL ENRICHMENT FOR LEADS
 * NO CRUD
 * NO TABLE CONFIG
 * NO TRANSFORM ABUSE
 */
export async function resolveLeadsRead(
  leads: any[]
): Promise<any[]> {
  if (!leads || leads.length === 0) return leads;

  /* -----------------------------------------
     1️⃣ Collect lead IDs
  ----------------------------------------- */
  const leadIds = leads.map(l => l.id);

  /* -----------------------------------------
     2️⃣ Find USED leads
     (separate query, no joins)
  ----------------------------------------- */
  const { data: campaignRows, error } = await supabase
    .from('campaign_leads')
    .select('lead_id')
    .in('lead_id', leadIds);

  if (error) {
    throw error;
  }

  const usedLeadSet = new Set(
    campaignRows.map((r: any) => r.lead_id)
  );

  /* -----------------------------------------
     3️⃣ Enrich read model
  ----------------------------------------- */
  return leads.map(lead => ({
    ...lead,

    // READ-ONLY FLAGS
    is_used: usedLeadSet.has(lead.id),

    is_blocked:
      lead.email_eligibility === 'blocked' ||
      lead.permanently_failed === true,
  }));
}
