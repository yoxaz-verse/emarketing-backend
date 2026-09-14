import { supabase } from '../supabase';

export type CampaignDeletePreview = {
  campaign: { id: string; name: string | null; status: string | null };
  canDelete: boolean;
  blocker?: string;
  deletes: Record<string, number>;
  preserves: string[];
};

export type CampaignDeleteAuth = { role?: string | null; operator_id?: string | null };

function isAdmin(auth?: CampaignDeleteAuth) {
  return ['admin', 'superadmin'].includes(String(auth?.role ?? '').toLowerCase());
}

function requireScope(auth?: CampaignDeleteAuth) {
  const operatorId = String(auth?.operator_id ?? '').trim();
  if (!isAdmin(auth) && !operatorId) {
    const error = new Error('Operator access required') as Error & { statusCode: number };
    error.statusCode = 403;
    throw error;
  }
  return isAdmin(auth) ? null : operatorId;
}

function mapRpcError(error: any): never {
  const message = String(error?.message ?? 'Campaign deletion failed');
  const result = new Error(message) as Error & { statusCode: number };
  result.statusCode = /not found/i.test(message) ? 404 : /pause|running|cannot delete/i.test(message) ? 409 : 500;
  throw result;
}

export async function getCampaignDeletePreview(campaignId: string, auth?: CampaignDeleteAuth): Promise<CampaignDeletePreview> {
  const { data, error } = await supabase.rpc('campaign_delete_preview', {
    p_campaign_id: campaignId,
    p_operator_id: requireScope(auth),
  });
  if (error) mapRpcError(error);
  return data as CampaignDeletePreview;
}

export async function deleteCampaigns(ids: string[], auth?: CampaignDeleteAuth): Promise<number> {
  const uniqueIds = [...new Set(ids.map((id) => String(id).trim()).filter(Boolean))];
  if (!uniqueIds.length) return 0;
  const { data, error } = await supabase.rpc('delete_campaigns_with_data', {
    p_campaign_ids: uniqueIds,
    p_operator_id: requireScope(auth),
  });
  if (error) mapRpcError(error);
  return Number(data ?? 0);
}
