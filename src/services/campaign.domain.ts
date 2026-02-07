import { supabase } from "../supabase";
import { updateRow } from "./crudService";

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
    return { inserted: 0 };
  }

  /* -------------------------------------------------------
     1️⃣ Fetch existing campaign_leads
  ------------------------------------------------------- */
  const { data: existing, error: fetchError } = await supabase
    .from('campaign_leads')
    .select('lead_id')
    .eq('campaign_id', campaignId)
    .in('lead_id', leadIds);

  if (fetchError) {
    throw fetchError;
  }

  const existingLeadIds = new Set(
    (existing ?? []).map((r: any) => r.lead_id)
  );

  /* -------------------------------------------------------
     2️⃣ Determine new leads only
  ------------------------------------------------------- */
  const newLeadIds = leadIds.filter(
    (id) => !existingLeadIds.has(id)
  );

  if (newLeadIds.length === 0) {
    return { inserted: 0 };
  }

  /* -------------------------------------------------------
     3️⃣ Build rows (NEW leads ONLY)
  ------------------------------------------------------- */
  const rows = newLeadIds.map((leadId) => ({
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

  return {
    inserted: rows.length,
  };
}




/**
 * Start campaign (IDEMPOTENT)
 */
export async function startCampaign(campaignId: string) {
  // 1️⃣ Fetch campaign
  const { data: campaign, error } = await supabase
    .from('campaigns')
    .select('id, status')
    .eq('id', campaignId)
    .single();

  if (error || !campaign) {
    throw new Error('Campaign not found');
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
    throw new Error('Cannot start campaign without assigned inboxes');
  }

  // 3️⃣ Transition campaign to running
  await updateRow('campaigns', campaignId, {
    status: 'running',
    started_at: new Date().toISOString(),
  });

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
export async function pauseCampaign(campaignId: string) {
  await updateRow("campaigns", campaignId, {
    status: "paused",
  });

  // 🔒 LOG EVENT
  await supabase.from('system_events').insert({
    type: 'campaign_paused',
    entity: 'campaign',
    entity_id: campaignId,
    message: `Campaign paused`
  });
}
