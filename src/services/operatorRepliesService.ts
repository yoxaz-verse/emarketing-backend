import { supabase } from '../supabase.js';

export async function getOperatorReplies(  operatorId: string | null
) {
  const { data } = await supabase
    .from('leads')
    .select(`
      id,
      email,
      first_name,
      company,
      country,
      replied_at,
      reply_message,
      interest_status,
      interest_note,
      interest_reviewed_at,
      interest_reviewed_by,
      campaign_leads (
        campaign_id,
        campaigns (
          name
        )
      ),
      inboxes (
        email_address
      )
    `)
    .eq('operator_id', operatorId)
    .eq('status', 'replied')
    .order('replied_at', { ascending: false });

  return data ?? [];
}

export async function reviewLeadInterest(params: {
  leadId: string;
  interest_status: 'unreviewed' | 'interested' | 'not_interested';
  interest_note?: string | null;
  reviewed_by?: string | null;
}) {
  const now = new Date().toISOString();
  const payload = {
    interest_status: params.interest_status,
    interest_note: params.interest_note ?? null,
    interest_reviewed_at: params.interest_status === 'unreviewed' ? null : now,
    interest_reviewed_by: params.interest_status === 'unreviewed' ? null : (params.reviewed_by ?? null),
  };

  const { error } = await supabase
    .from('leads')
    .update(payload)
    .eq('id', params.leadId);

  if (error) throw error;
  return { success: true };
}
