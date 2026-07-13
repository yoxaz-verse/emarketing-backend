import { supabase } from '../supabase';

export type CampaignDeletePreview = {
  campaign: { id: string; name: string | null; status: string | null };
  canDelete: boolean;
  blocker?: string;
  deletes: {
    campaigns: 1;
    campaign_leads: number;
    campaign_inboxes: number;
    campaign_voice_agents: number;
    email_logs: number;
    email_tracking_events: number;
    system_events: number;
  };
  preserves: string[];
};

function createHttpError(message: string, statusCode: number) {
  const error = new Error(message) as Error & { statusCode?: number };
  error.statusCode = statusCode;
  return error;
}

function isRunningStatus(status: unknown): boolean {
  return String(status ?? '').trim().toLowerCase() === 'running';
}

async function countRows(table: string, column: string, value: string): Promise<number> {
  const { count, error } = await supabase
    .from(table)
    .select('id', { count: 'exact', head: true })
    .eq(column, value);

  if (error) throw error;
  return Number(count ?? 0);
}

async function countCampaignSystemEvents(campaignId: string): Promise<number> {
  const { count, error } = await supabase
    .from('system_events')
    .select('id', { count: 'exact', head: true })
    .eq('entity_id', campaignId)
    .in('entity', ['campaign', 'campaigns']);

  if (error) throw error;
  return Number(count ?? 0);
}

async function loadCampaignLeadIds(campaignId: string): Promise<string[]> {
  const { data, error } = await supabase
    .from('campaign_leads')
    .select('id')
    .eq('campaign_id', campaignId);

  if (error) throw error;
  return (data ?? []).map((row: any) => String(row?.id ?? '').trim()).filter(Boolean);
}

export async function getCampaignDeletePreview(campaignId: string): Promise<CampaignDeletePreview> {
  const { data: campaign, error } = await supabase
    .from('campaigns')
    .select('id,name,status')
    .eq('id', campaignId)
    .maybeSingle();

  if (error) throw error;
  if (!campaign) throw createHttpError('Campaign not found', 404);

  const [
    campaignLeads,
    campaignInboxes,
    campaignVoiceAgents,
    emailLogs,
    emailTrackingEvents,
    systemEvents,
  ] = await Promise.all([
    countRows('campaign_leads', 'campaign_id', campaignId),
    countRows('campaign_inboxes', 'campaign_id', campaignId),
    countRows('campaign_voice_agents', 'campaign_id', campaignId),
    countRows('email_logs', 'campaign_id', campaignId),
    countRows('email_tracking_events', 'campaign_id', campaignId),
    countCampaignSystemEvents(campaignId),
  ]);

  const canDelete = !isRunningStatus((campaign as any).status);

  return {
    campaign: {
      id: String((campaign as any).id),
      name: (campaign as any).name ?? null,
      status: (campaign as any).status ?? null,
    },
    canDelete,
    ...(canDelete ? {} : { blocker: 'Pause this campaign before deleting.' }),
    deletes: {
      campaigns: 1,
      campaign_leads: campaignLeads,
      campaign_inboxes: campaignInboxes,
      campaign_voice_agents: campaignVoiceAgents,
      email_logs: emailLogs,
      email_tracking_events: emailTrackingEvents,
      system_events: systemEvents,
    },
    preserves: ['leads', 'inboxes', 'voice_agents', 'sequences', 'operators', 'users'],
  };
}

async function deleteWhereCampaignId(table: string, campaignId: string) {
  const { error } = await supabase
    .from(table)
    .delete()
    .eq('campaign_id', campaignId);

  if (error) throw error;
}

async function deleteWhereCampaignLeadIds(table: string, campaignLeadIds: string[]) {
  if (campaignLeadIds.length === 0) return;

  const { error } = await supabase
    .from(table)
    .delete()
    .in('campaign_lead_id', campaignLeadIds);

  if (error) throw error;
}

async function deleteCampaignSystemEvents(campaignId: string) {
  const { error } = await supabase
    .from('system_events')
    .delete()
    .eq('entity_id', campaignId)
    .in('entity', ['campaign', 'campaigns']);

  if (error) throw error;
}

export async function deleteCampaignDependents(campaignId: string) {
  const { data: campaign, error } = await supabase
    .from('campaigns')
    .select('id,status')
    .eq('id', campaignId)
    .maybeSingle();

  if (error) throw error;
  if (!campaign) return;
  if (isRunningStatus((campaign as any).status)) {
    throw createHttpError('Cannot delete a running campaign. Pause it first.', 409);
  }

  const campaignLeadIds = await loadCampaignLeadIds(campaignId);

  await deleteWhereCampaignLeadIds('email_tracking_events', campaignLeadIds);
  await deleteWhereCampaignId('email_tracking_events', campaignId);
  await deleteWhereCampaignLeadIds('email_logs', campaignLeadIds);
  await deleteWhereCampaignId('email_logs', campaignId);
  await deleteWhereCampaignId('campaign_voice_agents', campaignId);
  await deleteWhereCampaignId('campaign_inboxes', campaignId);
  await deleteWhereCampaignId('campaign_leads', campaignId);
  await deleteCampaignSystemEvents(campaignId);
}
