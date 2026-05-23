import { createHash } from 'crypto';
import { supabase } from '../supabase.js';

export async function getOperatorReplies(
  operatorId: string | null,
  options?: { campaignId?: string | null; reviewStatus?: 'all' | 'unreviewed' | 'reviewed' }
) {
  let trackingQuery: any = supabase
    .from('email_tracking_events')
    .select('id,event_at,lead_id,campaign_id,campaign_lead_id,inbox_id,raw_payload,from_email,to_email,matched')
    .eq('event_type', 'reply')
    .order('event_at', { ascending: false })
    .limit(500);

  if (options?.campaignId) {
    trackingQuery = trackingQuery.eq('campaign_id', String(options.campaignId));
  }

  const { data: trackingRows, error: trackingErr } = await trackingQuery;
  if (trackingErr) throw trackingErr;

  const leadIds = Array.from(new Set(
    (trackingRows ?? [])
      .map((row: any) => String(row?.lead_id ?? '').trim())
      .filter(Boolean)
  ));
  if (leadIds.length === 0) return [];

  let leadsQuery: any = supabase
    .from('leads')
    .select('id,email,first_name,company,country,reply_message,interest_status,interest_note,interest_reviewed_at,interest_reviewed_by,operator_id')
    .in('id', leadIds);

  if (operatorId) {
    leadsQuery = leadsQuery.eq('operator_id', operatorId);
  }
  if (options?.reviewStatus === 'unreviewed') {
    leadsQuery = leadsQuery.eq('interest_status', 'unreviewed');
  } else if (options?.reviewStatus === 'reviewed') {
    leadsQuery = leadsQuery.in('interest_status', ['interested', 'not_interested']);
  }

  const { data: leadRows, error: leadErr } = await leadsQuery;
  if (leadErr) throw leadErr;
  const leadById = new Map(
    (leadRows ?? []).map((row: any) => [String(row.id), row])
  );

  const campaignIds = Array.from(new Set(
    (trackingRows ?? [])
      .map((row: any) => String(row?.campaign_id ?? '').trim())
      .filter(Boolean)
  ));
  const inboxIds = Array.from(new Set(
    (trackingRows ?? [])
      .map((row: any) => String(row?.inbox_id ?? '').trim())
      .filter(Boolean)
  ));

  const campaignNameById = new Map<string, string>();
  if (campaignIds.length > 0) {
    const { data: campaignRows, error: campaignErr } = await supabase
      .from('campaigns')
      .select('id,name')
      .in('id', campaignIds);
    if (campaignErr) throw campaignErr;
    for (const campaignRow of campaignRows ?? []) {
      const id = String((campaignRow as any)?.id ?? '').trim();
      if (!id) continue;
      campaignNameById.set(id, String((campaignRow as any)?.name ?? '').trim());
    }
  }

  const inboxEmailById = new Map<string, string>();
  if (inboxIds.length > 0) {
    const { data: inboxRows, error: inboxErr } = await supabase
      .from('inboxes')
      .select('id,email_address')
      .in('id', inboxIds);
    if (inboxErr) throw inboxErr;
    for (const inboxRow of inboxRows ?? []) {
      const id = String((inboxRow as any)?.id ?? '').trim();
      if (!id) continue;
      inboxEmailById.set(id, String((inboxRow as any)?.email_address ?? '').trim().toLowerCase());
    }
  }

  const rows = (trackingRows ?? [])
    .map((trackingRow: any) => {
      const leadId = String(trackingRow?.lead_id ?? '').trim();
      const lead = leadById.get(leadId);
      if (!lead) return null;

      const campaignId = String(trackingRow?.campaign_id ?? '').trim();
      const rawPayload = (trackingRow?.raw_payload && typeof trackingRow.raw_payload === 'object')
        ? trackingRow.raw_payload
        : {};
      const rawMessage = typeof (rawPayload as any)?.message === 'string'
        ? String((rawPayload as any).message).trim()
        : '';

      return {
        id: String((lead as any)?.id ?? ''),
        reply_event_id: String(trackingRow?.id ?? ''),
        email: String((lead as any)?.email ?? ''),
        first_name: String((lead as any)?.first_name ?? ''),
        company: String((lead as any)?.company ?? ''),
        country: String((lead as any)?.country ?? ''),
        replied_at: String(trackingRow?.event_at ?? ''),
        reply_message: rawMessage || String((lead as any)?.reply_message ?? '') || null,
        interest_status: (lead as any)?.interest_status ?? null,
        interest_note: (lead as any)?.interest_note ?? null,
        interest_reviewed_at: (lead as any)?.interest_reviewed_at ?? null,
        interest_reviewed_by: (lead as any)?.interest_reviewed_by ?? null,
        campaign_leads: campaignId
          ? [
              {
                campaign_id: campaignId,
                campaigns: {
                  name: campaignNameById.get(campaignId) ?? '',
                },
              },
            ]
          : [],
        inboxes: {
          email_address: inboxEmailById.get(String(trackingRow?.inbox_id ?? '').trim()) ?? '',
        },
        tracking_source: String((rawPayload as any)?.source ?? ''),
        tracking_confidence: String((rawPayload as any)?.correlation_confidence ?? ''),
      };
    })
    .filter(Boolean);

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

  const rows = (data ?? []).map((row: any) => ({
    ...row,
    scope_match_source: null as string | null,
    scope_confidence: null as string | null,
  }));
  if (!options?.campaignId) return rows;

  const targetCampaignId = String(options.campaignId);
  const messageIds = rows
    .map((row: any) => String(row?.message_id ?? '').trim().toLowerCase())
    .filter(Boolean);

  const matchedByMessageId = new Set<string>();
  if (messageIds.length > 0) {
    const { data: logRows, error: logErr } = await supabase
      .from('email_logs')
      .select('provider_message_id,campaign_id')
      .in('provider_message_id', messageIds)
      .eq('campaign_id', targetCampaignId);
    if (logErr) throw logErr;

    for (const row of logRows ?? []) {
      const messageId = String((row as any)?.provider_message_id ?? '').trim().toLowerCase();
      if (messageId) matchedByMessageId.add(messageId);
    }
  }

  const byRecipient = new Map<string, Array<{
    sentAtMs: number;
    inboxEmail: string | null;
  }>>();
  const fallbackEmails = Array.from(
    new Set(
      rows
        .map((row: any) => String(row?.from_email ?? '').trim().toLowerCase())
        .filter(Boolean)
    )
  );
  if (fallbackEmails.length > 0) {
    const cutoffIso = new Date(Date.now() - (14 * 24 * 60 * 60 * 1000)).toISOString();
    const { data: sentRows, error: sentErr } = await supabase
      .from('email_logs')
      .select('to_email,inbox_id,sent_at')
      .eq('campaign_id', targetCampaignId)
      .in('to_email', fallbackEmails)
      .gte('sent_at', cutoffIso)
      .order('sent_at', { ascending: false })
      .limit(2000);
    if (sentErr) throw sentErr;

    const inboxIds = Array.from(new Set(
      (sentRows ?? [])
        .map((row: any) => String(row?.inbox_id ?? '').trim())
        .filter(Boolean)
    ));
    const inboxEmailById = new Map<string, string>();
    if (inboxIds.length > 0) {
      const { data: inboxRows, error: inboxErr } = await supabase
        .from('inboxes')
        .select('id,email_address')
        .in('id', inboxIds);
      if (inboxErr) throw inboxErr;
      for (const inboxRow of inboxRows ?? []) {
        const id = String((inboxRow as any)?.id ?? '').trim();
        const email = String((inboxRow as any)?.email_address ?? '').trim().toLowerCase();
        if (id && email) inboxEmailById.set(id, email);
      }
    }

    for (const row of sentRows ?? []) {
      const toEmail = String((row as any)?.to_email ?? '').trim().toLowerCase();
      const sentAtMs = new Date((row as any)?.sent_at ?? '').getTime();
      if (!toEmail || !Number.isFinite(sentAtMs)) continue;
      const inboxId = String((row as any)?.inbox_id ?? '').trim();
      const inboxEmail = inboxId ? (inboxEmailById.get(inboxId) ?? null) : null;
      const list = byRecipient.get(toEmail) ?? [];
      list.push({ sentAtMs, inboxEmail });
      byRecipient.set(toEmail, list);
    }
  }

  return rows.filter((row: any) => {
    const messageId = String(row?.message_id ?? '').trim().toLowerCase();
    if (messageId && matchedByMessageId.has(messageId)) {
      row.scope_match_source = 'message_id';
      row.scope_confidence = 'high';
      return true;
    }

    const fromEmail = String(row?.from_email ?? '').trim().toLowerCase();
    const receivedAtMs = new Date(row?.received_at ?? '').getTime();
    if (!fromEmail || !Number.isFinite(receivedAtMs)) return false;
    const candidates = byRecipient.get(fromEmail) ?? [];
    const inboxEmail = String(row?.inbox_email ?? '').trim().toLowerCase();

    for (const candidate of candidates) {
      const deltaMs = receivedAtMs - candidate.sentAtMs;
      if (deltaMs < 0 || deltaMs > (14 * 24 * 60 * 60 * 1000)) continue;
      if (candidate.inboxEmail && inboxEmail && candidate.inboxEmail !== inboxEmail) continue;
      row.scope_match_source = 'recipient_time_window';
      row.scope_confidence = 'low';
      return true;
    }

    return false;
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

  let campaignLeadId: string | null = params.campaignLeadId ? String(params.campaignLeadId) : null;
  let campaignId: string | null = null;
  let resolvedInboxId: string | null = null;
  let toEmail: string | null = null;
  const normalizedMessageId = String((eventRow as any)?.message_id ?? '').trim().replace(/[<>]/g, '').toLowerCase();

  if (campaignLeadId) {
    const { data: campaignLead } = await supabase
      .from('campaign_leads')
      .select('id,campaign_id,assigned_inbox_id,leads(email)')
      .eq('id', campaignLeadId)
      .maybeSingle();
    if (campaignLead) {
      campaignId = String((campaignLead as any)?.campaign_id ?? '') || null;
      resolvedInboxId = String((campaignLead as any)?.assigned_inbox_id ?? '') || null;
      toEmail = String((campaignLead as any)?.leads?.email ?? '').trim().toLowerCase() || null;
    }
  } else if (normalizedMessageId) {
    const { data: mailLog } = await supabase
      .from('email_logs')
      .select('campaign_lead_id,campaign_id,inbox_id,to_email')
      .eq('provider_message_id', normalizedMessageId)
      .order('sent_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (mailLog) {
      campaignLeadId = String((mailLog as any)?.campaign_lead_id ?? '') || null;
      campaignId = String((mailLog as any)?.campaign_id ?? '') || null;
      resolvedInboxId = String((mailLog as any)?.inbox_id ?? '') || null;
      toEmail = String((mailLog as any)?.to_email ?? '').trim().toLowerCase() || null;
    }
  }

  if (!campaignLeadId) {
    const { data: latestCampaignLead } = await supabase
      .from('campaign_leads')
      .select('id,campaign_id,assigned_inbox_id,leads(email)')
      .eq('lead_id', leadId)
      .order('processing_at', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (latestCampaignLead) {
      campaignLeadId = String((latestCampaignLead as any)?.id ?? '') || null;
      campaignId = String((latestCampaignLead as any)?.campaign_id ?? '') || campaignId;
      resolvedInboxId = String((latestCampaignLead as any)?.assigned_inbox_id ?? '') || resolvedInboxId;
      toEmail = String((latestCampaignLead as any)?.leads?.email ?? '').trim().toLowerCase() || toEmail;
    }
  }

  const eventAt = String((eventRow as any)?.received_at ?? now);
  const trackingDedupeKey = createHash('sha256')
    .update(`manual_map_reply|${eventId}|${leadId}|${campaignLeadId ?? ''}|${campaignId ?? ''}`)
    .digest('hex');

  const { error: trackingErr } = await supabase
    .from('email_tracking_events')
    .insert({
      dedupe_key: trackingDedupeKey,
      event_type: 'reply',
      provider_name: 'imap',
      provider_message_id: normalizedMessageId || null,
      campaign_id: campaignId,
      campaign_lead_id: campaignLeadId,
      lead_id: leadId,
      inbox_id: resolvedInboxId,
      from_email: String((eventRow as any)?.from_email ?? '').trim().toLowerCase() || null,
      to_email: toEmail,
      event_at: eventAt,
      matched: Boolean(campaignLeadId || leadId),
      raw_payload: {
        source: 'manual_map',
        reply_event_id: eventId,
        reviewed_by: params.reviewedBy ?? null,
        correlation_confidence: campaignLeadId ? 'high' : 'medium',
      },
    });
  if (trackingErr && String((trackingErr as any)?.code ?? '') !== '23505') {
    throw trackingErr;
  }

  await supabase.from('system_events').insert({
    type: 'UNMATCHED_REPLY_MAPPED',
    entity: 'reply_ingest_events',
    entity_id: eventId,
    message: 'Unmatched reply was mapped to lead.',
    meta: {
      lead_id: leadId,
      campaign_lead_id: campaignLeadId ?? null,
      reviewed_by: params.reviewedBy ?? null,
    },
  });

  return { success: true, mapped: true };
}
