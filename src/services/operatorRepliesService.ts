import { supabase } from '../supabase.js';

export async function getOperatorReplies(
  operatorId: string | null,
  options?: { campaignId?: string | null; reviewStatus?: 'all' | 'unreviewed' | 'reviewed' }
) {
  let query: any = supabase
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
    .eq('status', 'replied')
    .order('replied_at', { ascending: false });

  if (operatorId) {
    query = query.eq('operator_id', operatorId);
  }

  if (options?.reviewStatus === 'unreviewed') {
    query = query.eq('interest_status', 'unreviewed');
  } else if (options?.reviewStatus === 'reviewed') {
    query = query.in('interest_status', ['interested', 'not_interested']);
  }

  const { data } = await query;
  let rows: any[] = data ?? [];
  if (options?.campaignId) {
    rows = rows.filter((row) =>
      Array.isArray(row?.campaign_leads) &&
      row.campaign_leads.some((cl: any) => String(cl?.campaign_id ?? '') === String(options.campaignId))
    );
  }
  return rows;
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

export async function getUnmatchedReplyEvents(
  operatorId: string | null,
  options?: { campaignId?: string | null }
) {
  let inboxEmails: string[] | null = null;

  if (operatorId) {
    const { data: inboxRows, error: inboxErr } = await supabase
      .from('inboxes')
      .select('email_address')
      .eq('operator_id', operatorId);
    if (inboxErr) throw inboxErr;
    inboxEmails = (inboxRows ?? [])
      .map((r: any) => String(r?.email_address ?? '').trim().toLowerCase())
      .filter(Boolean);
    if (!inboxEmails || inboxEmails.length === 0) return [];
  }

  let query: any = supabase
    .from('reply_ingest_events')
    .select('id,from_email,inbox_email,message_id,message,received_at,matched,lead_id')
    .eq('matched', false)
    .order('received_at', { ascending: false })
    .limit(200);

  if (inboxEmails) {
    query = query.in('inbox_email', inboxEmails);
  }

  const { data, error } = await query;
  if (error) throw error;

  const rows = data ?? [];
  if (!options?.campaignId) return rows;

  return rows.filter((row: any) => {
    const campaignId = String(row?.campaign_id ?? row?.meta?.campaign_id ?? '');
    return campaignId === String(options.campaignId);
  });
}

export async function mapUnmatchedReplyToLead(params: {
  replyEventId: string;
  leadId?: string;
  leadEmail?: string;
  campaignLeadId?: string | null;
  reviewedBy?: string | null;
}) {
  const eventId = String(params.replyEventId ?? '').trim();
  if (!eventId) {
    throw new Error('replyEventId is required');
  }

  const { data: eventRow, error: eventErr } = await supabase
    .from('reply_ingest_events')
    .select('id,matched,message,from_email,inbox_email,message_id,received_at')
    .eq('id', eventId)
    .maybeSingle();
  if (eventErr) throw eventErr;
  if (!eventRow) throw new Error('Reply event not found');
  if (Boolean((eventRow as any).matched)) {
    return { success: true, already_mapped: true };
  }

  let leadId = String(params.leadId ?? '').trim();
  if (!leadId) {
    const email = String(params.leadEmail ?? (eventRow as any)?.from_email ?? '').trim().toLowerCase();
    if (!email) throw new Error('leadId or leadEmail is required');
    const { data: matchedLead, error: leadErr } = await supabase
      .from('leads')
      .select('id')
      .eq('email', email)
      .limit(1)
      .maybeSingle();
    if (leadErr) throw leadErr;
    leadId = String((matchedLead as any)?.id ?? '').trim();
    if (!leadId) throw new Error('No lead found for sender email');
  }

  const now = new Date().toISOString();
  await supabase
    .from('leads')
    .update({
      status: 'replied',
      replied_at: now,
      reply_message: String((eventRow as any)?.message ?? '') || null,
      interest_status: 'unreviewed',
    })
    .eq('id', leadId);

  if (params.campaignLeadId) {
    await supabase
      .from('campaign_leads')
      .update({ status: 'replied' })
      .eq('id', String(params.campaignLeadId))
      .in('status', ['queued', 'processing', 'paused', 'completed']);
  } else {
    await supabase
      .from('campaign_leads')
      .update({ status: 'replied' })
      .eq('lead_id', leadId)
      .in('status', ['queued', 'processing', 'paused', 'completed']);
  }

  await supabase
    .from('reply_ingest_events')
    .update({
      matched: true,
      lead_id: leadId,
    })
    .eq('id', eventId);

  await supabase.from('system_events').insert({
    type: 'UNMATCHED_REPLY_MAPPED',
    entity: 'reply_ingest_events',
    entity_id: eventId,
    message: 'Unmatched reply was mapped to lead.',
    meta: {
      lead_id: leadId,
      campaign_lead_id: params.campaignLeadId ?? null,
      reviewed_by: params.reviewedBy ?? null,
    },
  });

  return { success: true, mapped: true };
}
