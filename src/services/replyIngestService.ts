import { createHash } from 'crypto';
import { supabase } from '../supabase.js';

type InboundReplyPayload = {
  from_email?: string;
  message?: string;
  inbox_email?: string;
  message_id?: string;
  received_at?: string;
  leadId?: string;
  source?: 'imap_poll' | 'manual_api' | 'provider_webhook' | 'unknown';
  skipTrackingEvent?: boolean;
};

function normalizeMessageId(value: unknown): string {
  return String(value ?? '').trim().replace(/[<>]/g, '').toLowerCase();
}

function toDedupeKey(payload: {
  fromEmail: string;
  message: string;
  messageId: string;
  receivedAtIso: string;
}) {
  const bucket = payload.receivedAtIso.slice(0, 13); // hour bucket
  const base = payload.messageId
    ? `mid:${payload.messageId}`
    : `fallback:${payload.fromEmail}|${payload.message.slice(0, 200)}|${bucket}`;
  return createHash('sha256').update(base).digest('hex');
}

async function updateCampaignLeadsToReplied(filter: { id?: string; lead_id?: string }) {
  let query: any = supabase
    .from('campaign_leads')
    .update({ status: 'replied' })
    .in('status', ['queued', 'processing', 'paused', 'completed']);
  if (filter.id) query = query.eq('id', filter.id);
  if (filter.lead_id) query = query.eq('lead_id', filter.lead_id);
  const { error, count } = await query.select('id', { count: 'exact', head: true });
  if (error) throw error;
  return Number(count ?? 0);
}

export async function ingestInboundReply(input: InboundReplyPayload) {
  const fromEmail = String(input.from_email ?? '').trim().toLowerCase();
  const message = String(input.message ?? '').trim();
  const messageId = normalizeMessageId(input.message_id);
  const inboxEmail = String(input.inbox_email ?? '').trim().toLowerCase();
  const receivedAtIso = input.received_at
    ? new Date(input.received_at).toISOString()
    : new Date().toISOString();
  const dedupeKey = toDedupeKey({ fromEmail, message, messageId, receivedAtIso });

  // Resolve order: message-id correlation -> explicit leadId -> from-email fallback.
  let lead: any = null;
  let campaignLeadId: string | null = null;
  let campaignId: string | null = null;
  let resolvedInboxId: string | null = null;
  let resolvedToEmail: string | null = null;

  if (messageId) {
    const { data: mailLog } = await supabase
      .from('email_logs')
      .select('campaign_lead_id,campaign_id,inbox_id,lead_id,to_email')
      .eq('provider_message_id', messageId)
      .order('sent_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    campaignLeadId = String((mailLog as any)?.campaign_lead_id ?? '') || null;
    campaignId = String((mailLog as any)?.campaign_id ?? '') || null;
    resolvedInboxId = String((mailLog as any)?.inbox_id ?? '') || null;
    resolvedToEmail = String((mailLog as any)?.to_email ?? '').trim().toLowerCase() || null;

    if ((mailLog as any)?.lead_id) {
      const derivedLeadId = String((mailLog as any).lead_id);
      const { data } = await supabase
        .from('leads')
        .select('id, email, status, interest_status')
        .eq('id', derivedLeadId)
        .maybeSingle();
      if (data) {
        lead = data;
      }
    }
  }

  if (!lead && input.leadId) {
    const { data } = await supabase
      .from('leads')
      .select('id, email, status, interest_status')
      .eq('id', String(input.leadId))
      .maybeSingle();
    lead = data;
  }

  if (!lead && fromEmail) {
    const { data, error } = await supabase
      .from('leads')
      .select('id, email, status, interest_status')
      .eq('email', fromEmail)
      .limit(2);
    if (error) throw error;
    const candidates = Array.isArray(data) ? data : [];
    if (candidates.length === 1) {
      lead = candidates[0];
    }
  }

  const resolvedLeadId = String(lead?.id ?? '');

  const { error: ingestInsertError } = await supabase
    .from('reply_ingest_events')
    .insert({
      dedupe_key: dedupeKey,
      lead_id: resolvedLeadId || null,
      matched: Boolean(resolvedLeadId),
      from_email: fromEmail || null,
      inbox_email: inboxEmail || null,
      message_id: messageId || null,
      message: message || null,
      received_at: receivedAtIso,
    });

  if (ingestInsertError) {
    if (String((ingestInsertError as any)?.code ?? '') === '23505') {
      return { success: true, matched: Boolean(resolvedLeadId), lead_id: resolvedLeadId || undefined, deduped: true };
    }
    throw ingestInsertError;
  }

  const finalLeadId = resolvedLeadId;

  if (!finalLeadId) {
    await supabase.from('system_events').insert({
      type: 'UNMATCHED_REPLY_RECEIVED',
      entity: 'reply_ingest_events',
      message: `Reply received from unknown sender ${fromEmail || '[missing-from]'}`,
      meta: {
        from_email: fromEmail || null,
        inbox_email: inboxEmail || null,
        message_id: messageId || null,
        dedupe_key: dedupeKey,
      },
    });
    return { success: true, matched: false, deduped: false, campaign_lead_id: campaignLeadId ?? undefined };
  }

  // Mark lead replied and keep manual review queue.
  const now = new Date().toISOString();
  const { error: leadUpdateError } = await supabase
    .from('leads')
    .update({
      status: 'replied',
      replied_at: now,
      reply_message: message || null,
      interest_status: 'unreviewed',
    })
    .eq('id', finalLeadId);
  if (leadUpdateError) {
    throw new Error(`reply_ingest_failed: lead_update_error: ${leadUpdateError.message}`);
  }

  if (campaignLeadId) {
    const updated = await updateCampaignLeadsToReplied({ id: campaignLeadId });
    if (updated === 0) {
      console.warn('[REPLY_INGEST_CAMPAIGN_LEAD_STATUS_NOT_UPDATED]', { campaignLeadId, dedupeKey, finalLeadId });
    }
  } else {
    const updated = await updateCampaignLeadsToReplied({ lead_id: finalLeadId });
    if (updated === 0) {
      console.warn('[REPLY_INGEST_CAMPAIGN_LEAD_STATUS_NOT_UPDATED]', { finalLeadId, dedupeKey });
    }

    // Try to resolve campaign context for tracking when message-id is missing.
    const { data: latestCampaignLead } = await supabase
      .from('campaign_leads')
      .select('id,campaign_id,assigned_inbox_id')
      .eq('lead_id', finalLeadId)
      .in('status', ['replied', 'completed', 'processing', 'paused', 'queued'])
      .order('processing_at', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (latestCampaignLead) {
      campaignLeadId = String((latestCampaignLead as any)?.id ?? '') || campaignLeadId;
      campaignId = String((latestCampaignLead as any)?.campaign_id ?? '') || campaignId;
      resolvedInboxId = String((latestCampaignLead as any)?.assigned_inbox_id ?? '') || resolvedInboxId;
    }
  }

  // Ensure strict reply-rate KPI can move even when reply is captured via IMAP/manual paths.
  if (!input.skipTrackingEvent) {
    const trackingDedupeKey = createHash('sha256')
      .update(`reply_ingest_tracking|${dedupeKey}|${campaignLeadId ?? ''}|${campaignId ?? ''}`)
      .digest('hex');
    const { error: trackingError } = await supabase
      .from('email_tracking_events')
      .insert({
        dedupe_key: trackingDedupeKey,
        event_type: 'reply',
        provider_name: 'imap',
        provider_message_id: messageId || null,
        campaign_id: campaignId,
        campaign_lead_id: campaignLeadId,
        lead_id: finalLeadId,
        inbox_id: resolvedInboxId,
        from_email: fromEmail || null,
        to_email: resolvedToEmail,
        event_at: receivedAtIso,
        matched: Boolean(campaignLeadId || finalLeadId),
        raw_payload: {
          source: input.source ?? 'unknown',
          ingested_via: 'reply_ingest_service',
          dedupe_key: dedupeKey,
          correlation_confidence: campaignLeadId ? 'high' : 'medium',
        },
      });
    if (trackingError && String((trackingError as any)?.code ?? '') !== '23505') {
      throw new Error(`reply_ingest_failed: tracking_event_insert_error: ${trackingError.message}`);
    }
  }

  await supabase.from('system_events').insert({
    type: 'LEAD_REPLIED',
    entity: 'lead',
    entity_id: finalLeadId,
    message: 'Reply received and campaign lead flow stopped.',
    meta: {
      from_email: fromEmail || null,
      inbox_email: inboxEmail || resolvedInboxId || null,
      message_id: messageId || null,
      dedupe_key: dedupeKey,
      campaign_id: campaignId,
      campaign_lead_id: campaignLeadId,
    },
  });

  return { success: true, matched: true, lead_id: finalLeadId, campaign_lead_id: campaignLeadId ?? undefined, deduped: false };
}

// Backward-compat wrapper for existing internal routes.
export async function handleReply(params: { leadId?: string; inboxId?: string; message?: string }) {
  return ingestInboundReply({
    leadId: params.leadId,
    message: params.message,
    source: 'manual_api',
  });
}
