import { createHash } from 'crypto';
import { supabase } from '../supabase.js';

type InboundReplyPayload = {
  from_email?: string;
  message?: string;
  inbox_email?: string;
  message_id?: string;
  received_at?: string;
  leadId?: string;
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

export async function ingestInboundReply(input: InboundReplyPayload) {
  const fromEmail = String(input.from_email ?? '').trim().toLowerCase();
  const message = String(input.message ?? '').trim();
  const messageId = normalizeMessageId(input.message_id);
  const inboxEmail = String(input.inbox_email ?? '').trim().toLowerCase();
  const receivedAtIso = input.received_at
    ? new Date(input.received_at).toISOString()
    : new Date().toISOString();
  const dedupeKey = toDedupeKey({ fromEmail, message, messageId, receivedAtIso });

  // Resolve lead by explicit leadId (legacy path) or by from email (webhook path).
  let lead: any = null;
  if (input.leadId) {
    const { data } = await supabase
      .from('leads')
      .select('id, email, status, interest_status')
      .eq('id', String(input.leadId))
      .maybeSingle();
    lead = data;
  } else if (fromEmail) {
    const { data } = await supabase
      .from('leads')
      .select('id, email, status, interest_status')
      .eq('email', fromEmail)
      .maybeSingle();
    lead = data;
  }

  const leadId = String(lead?.id ?? '');
  let campaignLeadId: string | null = null;
  let campaignId: string | null = null;
  let resolvedInboxId: string | null = null;

  if (messageId) {
    const { data: mailLog } = await supabase
      .from('email_logs')
      .select('campaign_lead_id,campaign_id,inbox_id,lead_id')
      .eq('provider_message_id', messageId)
      .order('sent_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    campaignLeadId = String((mailLog as any)?.campaign_lead_id ?? '') || null;
    campaignId = String((mailLog as any)?.campaign_id ?? '') || null;
    resolvedInboxId = String((mailLog as any)?.inbox_id ?? '') || null;

    if (!leadId && (mailLog as any)?.lead_id) {
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
  await supabase
    .from('leads')
    .update({
      status: 'replied',
      replied_at: now,
      reply_message: message || null,
      interest_status: 'unreviewed',
    })
    .eq('id', finalLeadId);

  if (campaignLeadId) {
    await supabase
      .from('campaign_leads')
      .update({ status: 'replied' })
      .eq('id', campaignLeadId)
      .in('status', ['queued', 'processing', 'paused', 'completed']);
  } else {
    await supabase
      .from('campaign_leads')
      .update({ status: 'replied' })
      .eq('lead_id', finalLeadId)
      .in('status', ['queued', 'processing', 'paused', 'completed']);
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
  });
}
