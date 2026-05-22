import { supabase } from "../supabase";
type AuthContext = {
  role?: string | null;
  operator_id?: string | null;
  user_id?: string | null;
};

function createHttpError(message: string, statusCode: number) {
  const error = new Error(message) as Error & { statusCode?: number };
  error.statusCode = statusCode;
  return error;
}

function mapDetachConflictError(err: any): never {
  const code = String(err?.code ?? '');
  const message = String(err?.message ?? '');
  const details = String(err?.details ?? '');
  const hint = String(err?.hint ?? '');
  const combined = `${message} ${details} ${hint}`.toLowerCase();
  const isForeignKeyConflict =
    code === '23503' ||
    combined.includes('foreign key') ||
    combined.includes('email_tracking_events_campaign_lead_id_fkey') ||
    combined.includes('email_logs_campaign_lead_id_fkey');

  if (isForeignKeyConflict) {
    const conflict = createHttpError(
      'Cannot remove campaign lead because related tracking records are still linked. Apply FK migration (ON DELETE SET NULL) and retry.',
      409
    ) as Error & { code?: string };
    conflict.code = 'CAMPAIGN_LEAD_TRACKING_CONFLICT';
    throw conflict;
  }
  throw err;
}

async function assertCampaignIsMutableForLeadMutation(campaignId: string) {
  const { data: campaign, error } = await supabase
    .from('campaigns')
    .select('id,status')
    .eq('id', campaignId)
    .maybeSingle();

  if (error) throw error;
  if (!campaign) throw createHttpError('Campaign not found.', 404);
  const normalizedStatus = String(campaign.status ?? '').toLowerCase();
  if (normalizedStatus === 'running') {
    throw createHttpError('Campaign leads cannot be modified while campaign is running. Pause it first.', 409);
  }
}

/**
 * Attach leads to a campaign
 * NOTE: Direct supabase usage is acceptable here for now
 */
// services/campaignLeads.service.ts





/**
 * Attach leads to a campaign safely.
 * - Idempotent
 * - Does NOT reset existing campaign_leads
 * - Inserts ONLY missing leads
 */
export async function attachLeadsToCampaign(
  campaignId: string,
  leadIds: string[]
) {
  if (!campaignId) {
    throw new Error('campaignId is required');
  }

  if (!Array.isArray(leadIds) || leadIds.length === 0) {
    return {
      requested: 0,
      inserted: 0,
      detached: 0,
      skipped_existing: 0,
      skipped_ineligible: 0,
      skipped_missing: 0,
    };
  }
  await assertCampaignIsMutableForLeadMutation(campaignId);

  const dedupedLeadIds = Array.from(new Set(leadIds.map((id) => String(id))));
  const requested = dedupedLeadIds.length;

  /* -------------------------------------------------------
     1️⃣ Fetch existing campaign_leads
  ------------------------------------------------------- */
  const { data: existing, error: fetchError } = await supabase
    .from('campaign_leads')
    .select('lead_id')
    .eq('campaign_id', campaignId)
    .in('lead_id', dedupedLeadIds);

  if (fetchError) {
    throw fetchError;
  }

  const existingLeadIds = new Set((existing ?? []).map((r: any) => r.lead_id));

  const { data: leadRows, error: leadFetchError } = await supabase
    .from('leads')
    .select('id, email_eligibility, permanently_failed, is_used')
    .in('id', dedupedLeadIds);

  if (leadFetchError) {
    throw leadFetchError;
  }

  const allowedStatuses = new Set(['eligible', 'risky']);
  const leadStateMap = new Map<string, { eligibility: string; isBlocked: boolean; isUsed: boolean }>(
    (leadRows ?? []).map((row: any) => [
      String(row.id),
      {
        eligibility: String(row.email_eligibility ?? '').toLowerCase(),
        isBlocked:
          String(row.email_eligibility ?? '').toLowerCase() === 'blocked' ||
          row.permanently_failed === true,
        isUsed: row.is_used === true,
      },
    ])
  );

  /* -------------------------------------------------------
     2️⃣ Determine new leads only
  ------------------------------------------------------- */
  const foundLeadIds = new Set((leadRows ?? []).map((row: any) => String(row.id)));
  const missingLeadIds = dedupedLeadIds.filter((id) => !foundLeadIds.has(id));
  const newLeadIds = dedupedLeadIds.filter((id) => !existingLeadIds.has(id) && foundLeadIds.has(id));
  const eligibleLeadIds = newLeadIds.filter((id) => {
    const state = leadStateMap.get(String(id));
    if (!state) return false;
    if (!allowedStatuses.has(state.eligibility)) return false;
    if (state.isBlocked) return false;
    if (state.isUsed) return false;
    return true;
  });
  const skippedExisting = requested - newLeadIds.length;
  const skippedIneligible = newLeadIds.length - eligibleLeadIds.length;
  const skippedMissing = missingLeadIds.length;

  if (eligibleLeadIds.length === 0) {
    return {
      requested,
      inserted: 0,
      detached: 0,
      skipped_existing: skippedExisting,
      skipped_ineligible: skippedIneligible,
      skipped_missing: skippedMissing,
    };
  }

  /* -------------------------------------------------------
     3️⃣ Build rows (NEW leads ONLY)
  ------------------------------------------------------- */
  const rows = eligibleLeadIds.map((leadId) => ({
    campaign_id: campaignId,
    lead_id: leadId,
    status: 'queued',
    current_step: 1,
  }));

  /* -------------------------------------------------------
     4️⃣ Insert safely
  ------------------------------------------------------- */
  const { error: insertError } = await supabase
    .from('campaign_leads')
    .insert(rows);

  if (insertError) {
    throw insertError;
  }

  if (eligibleLeadIds.length > 0) {
    const { error: markUsedError } = await supabase
      .from('leads')
      .update({ is_used: true })
      .in('id', eligibleLeadIds);
    if (markUsedError) {
      throw markUsedError;
    }
  }

  return {
    requested,
    inserted: rows.length,
    detached: 0,
    skipped_existing: skippedExisting,
    skipped_ineligible: skippedIneligible,
    skipped_missing: skippedMissing,
  };
}

export async function detachLeadsFromCampaign(
  campaignId: string,
  leadIds: string[]
) {
  if (!campaignId) {
    throw new Error('campaignId is required');
  }

  if (!Array.isArray(leadIds) || leadIds.length === 0) {
    return {
      requested: 0,
      inserted: 0,
      detached: 0,
      skipped_existing: 0,
      skipped_ineligible: 0,
      skipped_missing: 0,
    };
  }
  await assertCampaignIsMutableForLeadMutation(campaignId);

  const dedupedLeadIds = Array.from(new Set(leadIds.map((id) => String(id))));
  const requested = dedupedLeadIds.length;

  const { data: existing, error: existingError } = await supabase
    .from('campaign_leads')
    .select('lead_id')
    .eq('campaign_id', campaignId)
    .in('lead_id', dedupedLeadIds);

  if (existingError) {
    throw existingError;
  }

  const existingLeadIds = new Set((existing ?? []).map((row: any) => String(row.lead_id)));
  const toDetachIds = dedupedLeadIds.filter((id) => existingLeadIds.has(id));
  const skippedMissing = requested - toDetachIds.length;

  if (toDetachIds.length === 0) {
    return {
      requested,
      inserted: 0,
      detached: 0,
      skipped_existing: 0,
      skipped_ineligible: 0,
      skipped_missing: skippedMissing,
    };
  }

  const { error: detachError } = await supabase
    .from('campaign_leads')
    .delete()
    .eq('campaign_id', campaignId)
    .in('lead_id', toDetachIds);

  if (detachError) {
    mapDetachConflictError(detachError);
  }

  const { data: stillAttachedRows, error: stillAttachedError } = await supabase
    .from('campaign_leads')
    .select('lead_id')
    .in('lead_id', toDetachIds);

  if (stillAttachedError) {
    throw stillAttachedError;
  }

  const stillAttachedSet = new Set((stillAttachedRows ?? []).map((row: any) => String(row.lead_id)));
  const nowUnusedLeadIds = toDetachIds.filter((id) => !stillAttachedSet.has(String(id)));
  if (nowUnusedLeadIds.length > 0) {
    const { error: markUnusedError } = await supabase
      .from('leads')
      .update({ is_used: false })
      .in('id', nowUnusedLeadIds);
    if (markUnusedError) {
      throw markUnusedError;
    }
  }

  return {
    requested,
    inserted: 0,
    detached: toDetachIds.length,
    skipped_existing: 0,
    skipped_ineligible: 0,
    skipped_missing: skippedMissing,
  };
}

export async function syncCampaignInboxes(
  campaignId: string,
  selectedInboxIds: string[]
) {
  if (!campaignId) {
    throw new Error('campaignId is required');
  }

  if (!Array.isArray(selectedInboxIds)) {
    throw new Error('selected_inbox_ids must be an array');
  }

  const dedupedSelectedInboxIds = Array.from(
    new Set(selectedInboxIds.map((id) => String(id)).filter(Boolean))
  );

  const { data: existingRows, error: existingError } = await supabase
    .from('campaign_inboxes')
    .select('id, inbox_id')
    .eq('campaign_id', campaignId);

  if (existingError) {
    throw existingError;
  }

  const existingInboxIds = new Set(
    (existingRows ?? []).map((row: any) => String(row.inbox_id))
  );
  const selectedSet = new Set(dedupedSelectedInboxIds);

  const toAttach = dedupedSelectedInboxIds.filter((id) => !existingInboxIds.has(id));
  const toDetachRows = (existingRows ?? []).filter(
    (row: any) => !selectedSet.has(String(row.inbox_id))
  );
  const unchanged = dedupedSelectedInboxIds.length - toAttach.length;

  if (toAttach.length > 0) {
    const conflicts = await getInboxLockConflicts(campaignId, toAttach);

    if (conflicts.length > 0) {
      const error = new Error('Some inboxes are locked by other active campaigns');
      (error as any).code = 'INBOX_LOCK_CONFLICT';
      (error as any).details = conflicts;
      throw error;
    }
  }

  if (toAttach.length > 0) {
    const insertPayload = toAttach.map((inboxId) => ({
      campaign_id: campaignId,
      inbox_id: inboxId,
    }));
    const { error: attachError } = await supabase
      .from('campaign_inboxes')
      .insert(insertPayload);
    if (attachError) {
      throw attachError;
    }
  }

  if (toDetachRows.length > 0) {
    const detachIds = toDetachRows.map((row: any) => String(row.id));
    const { error: detachError } = await supabase
      .from('campaign_inboxes')
      .delete()
      .in('id', detachIds);
    if (detachError) {
      throw detachError;
    }
  }

  // Strict reassign policy:
  // If an inbox is removed from this campaign, any queued/processing lead still bound to it
  // must be reset so future claims/sends can only use currently selected campaign inboxes.
  const removedInboxIds = toDetachRows
    .map((row: any) => String(row.inbox_id))
    .filter(Boolean);
  if (removedInboxIds.length > 0) {
    const { error: resetAssignmentsError } = await supabase
      .from('campaign_leads')
      .update({
        assigned_inbox_id: null,
        status: 'queued',
        status_reason: 'requeued_invalid_inbox_assignment',
        processing_at: null,
        execution_id: null,
      })
      .eq('campaign_id', campaignId)
      .in('status', ['queued', 'processing'])
      .in('assigned_inbox_id', removedInboxIds);

    if (resetAssignmentsError) {
      throw resetAssignmentsError;
    }
  }

  return {
    campaign_id: campaignId,
    selected: dedupedSelectedInboxIds.length,
    attached: toAttach.length,
    detached: toDetachRows.length,
    unchanged,
    errors: [] as string[],
  };
}

export async function getInboxLockConflicts(
  campaignId: string,
  inboxIds: string[]
): Promise<Array<{
  inbox_id: string;
  email_address: string;
  blocking_campaign_id: string;
  blocking_campaign_name: string;
  blocking_status: string;
  blocking_operator_id: string | null;
}>> {
  const dedupedInboxIds = Array.from(new Set((inboxIds ?? []).map((id) => String(id)).filter(Boolean)));
  if (dedupedInboxIds.length === 0) return [];

  const unlockedStatuses = new Set(['paused', 'completed', 'ended', 'cancelled', 'canceled']);
  const { data: lockRows, error: lockError } = await supabase
    .from('campaign_inboxes')
    .select(`
      inbox_id,
      campaign_id,
      campaigns!inner (
        id,
        name,
        status,
        operator_id
      ),
      inboxes (
        id,
        email_address
      )
    `)
    .in('inbox_id', dedupedInboxIds)
    .neq('campaign_id', campaignId);

  if (lockError) {
    throw lockError;
  }

  const conflicts = (lockRows ?? [])
    .map((row: any) => {
      const status = String(row?.campaigns?.status ?? '').toLowerCase();
      if (unlockedStatuses.has(status)) return null;
      return {
        inbox_id: String(row?.inbox_id ?? ''),
        email_address: String(row?.inboxes?.email_address ?? ''),
        blocking_campaign_id: String(row?.campaigns?.id ?? ''),
        blocking_campaign_name: String(row?.campaigns?.name ?? ''),
        blocking_status: String(row?.campaigns?.status ?? ''),
        blocking_operator_id: row?.campaigns?.operator_id ? String(row.campaigns.operator_id) : null,
      };
    })
    .filter(Boolean);

  const byInbox = new Map<string, (typeof conflicts)[number]>();
  for (const conflict of conflicts) {
    if (!conflict) continue;
    if (!byInbox.has(conflict.inbox_id)) {
      byInbox.set(conflict.inbox_id, conflict);
    }
  }

  return Array.from(byInbox.values());
}




/**
 * Start campaign (IDEMPOTENT)
 */
export async function startCampaign(campaignId: string, _auth?: AuthContext) {
  // 1️⃣ Fetch campaign
  const { data: campaign, error } = await supabase
    .from('campaigns')
    .select('id, status')
    .eq('id', campaignId)
    .single();

  if (error || !campaign) {
    throw createHttpError('Campaign not found', 404);
  }

  // 2️⃣ Idempotency guard
  if (campaign.status === 'running') {
    return;
  }

  // 🔒 NEW GUARD — campaign must have inboxes
  const { data: inboxes } = await supabase
    .from('campaign_inboxes')
    .select('inbox_id')
    .eq('campaign_id', campaignId)
    .limit(1);

  if (!inboxes || inboxes.length === 0) {
    throw createHttpError('Cannot start campaign without assigned inboxes', 409);
  }

  const { count: campaignLeadCount, error: campaignLeadCountError } = await supabase
    .from('campaign_leads')
    .select('id', { count: 'exact', head: true })
    .eq('campaign_id', campaignId);

  if (campaignLeadCountError) {
    throw campaignLeadCountError;
  }

  if (!campaignLeadCount || campaignLeadCount === 0) {
    throw createHttpError('Cannot start campaign without attached campaign leads', 409);
  }

  // 3️⃣ Transition campaign to running
  const { error: startUpdateError } = await supabase
    .from('campaigns')
    .update({
      status: 'running',
      started_at: new Date().toISOString(),
    })
    .eq('id', campaignId);

  if (startUpdateError) {
    throw startUpdateError;
  }

  // 🔒 LOG EVENT
  await supabase.from('system_events').insert({
    type: 'campaign_started',
    entity: 'campaign',
    entity_id: campaignId,
    message: `Campaign started`
  });

  // 4️⃣ Initialize campaign leads (if you already do this)
  await initializeCampaignLeads(campaignId);
}


/**
 * Initialize campaign leads for execution
 */
async function initializeCampaignLeads(campaignId: string) {
  await supabase
    .from("campaign_leads")
    .update({
      status: "queued",
      current_step: 1,
      retry_count: 0,
      next_retry_at: null,
      last_sent_at: null,
    })
    .eq("campaign_id", campaignId)
    .in("status", ["pending", "paused", null]);
}

/**
 * Pause campaign
 */
export async function pauseCampaign(campaignId: string, _auth?: AuthContext) {
  const { error: pauseUpdateError } = await supabase
    .from('campaigns')
    .update({
      status: 'paused',
    })
    .eq('id', campaignId);

  if (pauseUpdateError) {
    throw pauseUpdateError;
  }

  // 🔒 LOG EVENT
  await supabase.from('system_events').insert({
    type: 'campaign_paused',
    entity: 'campaign',
    entity_id: campaignId,
    message: `Campaign paused`
  });
}
