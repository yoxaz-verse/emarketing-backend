import { createHash } from 'crypto';
import { supabase } from '../supabase.js';
import { ingestInboundReply } from './replyIngestService.js';

type NormalizedEmailEvent = {
  event_type: 'open' | 'reply' | 'delivered' | 'bounced_hard' | 'bounced_soft';
  provider_name: string | null;
  provider_message_id: string;
  from_email: string | null;
  to_email: string | null;
  event_at: string;
  message: string | null;
  raw_payload: Record<string, unknown>;
  source?: 'provider_webhook' | 'pixel_fallback';
  confidence?: 'high' | 'medium' | 'low';
};

function readPath(input: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let current: any = input;
  for (const part of parts) {
    if (!current || typeof current !== 'object') return undefined;
    current = current[part];
  }
  return current;
}

function firstDefined(input: Record<string, unknown>, paths: string[]): unknown {
  for (const path of paths) {
    const value = readPath(input, path);
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      return value;
    }
  }
  return undefined;
}

function cleanEmail(value: unknown): string | null {
  const v = String(value ?? '').trim().toLowerCase();
  return v.length > 0 ? v : null;
}

function normalizeMessageId(value: unknown): string {
  return String(value ?? '').trim().replace(/[<>]/g, '').toLowerCase();
}

function toIso(value: unknown): string {
  const dt = new Date(String(value ?? ''));
  if (Number.isNaN(dt.getTime())) return new Date().toISOString();
  return dt.toISOString();
}

function dedupeKeyForEvent(evt: NormalizedEmailEvent): string {
  const base = [
    evt.event_type,
    evt.provider_name ?? '',
    evt.provider_message_id,
    evt.from_email ?? '',
    evt.to_email ?? '',
    evt.event_at.slice(0, 19),
  ].join('|');
  return createHash('sha256').update(base).digest('hex');
}

export function normalizeProviderEmailEvent(input: Record<string, unknown>) {
  const eventTypeRaw = String(
    firstDefined(input, [
      'event_type',
      'eventType',
      'type',
      'event',
      'notification_type',
      'notificationType',
      'mail.eventType',
      'data.eventType',
    ]) ?? ''
  )
    .trim()
    .toLowerCase();

  const bounceHint = String(
    firstDefined(input, [
      'bounce_type',
      'bounceType',
      'bounceKind',
      'severity',
      'subtype',
      'reason',
      'diagnostic',
      'bounce.bounceType',
      'bounce.bounceSubType',
      'mail.bounceType',
      'data.reason',
    ]) ?? ''
  ).toLowerCase();

  let event_type: NormalizedEmailEvent['event_type'] | null = null;
  if (eventTypeRaw.includes('reply')) event_type = 'reply';
  else if (eventTypeRaw.includes('open')) event_type = 'open';
  else if (eventTypeRaw.includes('deliver')) event_type = 'delivered';
  else if (eventTypeRaw.includes('bounce') || bounceHint.length > 0) {
    const isHard = /hard|permanent|5\.\d\.\d|invalid|rejected|does not exist|not found/.test(bounceHint);
    event_type = isHard ? 'bounced_hard' : 'bounced_soft';
  }

  const provider_message_id = normalizeMessageId(
    firstDefined(input, [
      'message_id',
      'messageId',
      'provider_message_id',
      'providerMessageId',
      'Message-Id',
      'message-id',
      'mail.messageId',
      'mail.message_id',
      'data.message_id',
      'data.messageId',
      'headers.message-id',
    ])
  );

  if (!event_type || !provider_message_id) {
    return null;
  }

  return {
    event_type,
    provider_name: String(
      firstDefined(input, ['provider', 'provider_name', 'providerName', 'source', 'mail.provider']) ?? ''
    ).trim() || null,
    provider_message_id,
    from_email: cleanEmail(firstDefined(input, ['from_email', 'fromEmail', 'from', 'mail.from', 'sender'])),
    to_email: cleanEmail(firstDefined(input, ['to_email', 'toEmail', 'recipient', 'to', 'mail.to', 'mail.recipient'])),
    event_at: toIso(firstDefined(input, ['event_at', 'eventAt', 'timestamp', 'received_at', 'date', 'mail.timestamp'])),
    message: typeof firstDefined(input, ['message', 'text', 'mail.message']) === 'string'
      ? String(firstDefined(input, ['message', 'text', 'mail.message']))
      : null,
    raw_payload: input,
  } as NormalizedEmailEvent;
}

async function resolveCorrelation(evt: NormalizedEmailEvent) {
  const { data } = await supabase
    .from('email_logs')
    .select('campaign_lead_id,campaign_id,lead_id,inbox_id,to_email')
    .eq('provider_message_id', evt.provider_message_id)
    .order('sent_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (data) {
    return {
      campaign_lead_id: (data as any)?.campaign_lead_id ?? null,
      campaign_id: (data as any)?.campaign_id ?? null,
      lead_id: (data as any)?.lead_id ?? null,
      inbox_id: (data as any)?.inbox_id ?? null,
      to_email: evt.to_email ?? (data as any)?.to_email ?? null,
      matched_by: 'message_id' as const,
      confidence: 'high' as const,
    };
  }

  const toEmail = cleanEmail(evt.to_email);
  const eventAt = new Date(evt.event_at);
  const sentWindowStart = new Date(eventAt.getTime() - (48 * 60 * 60 * 1000)).toISOString();
  const sentWindowEnd = new Date(eventAt.getTime() + (24 * 60 * 60 * 1000)).toISOString();

  if (toEmail) {
    const { data: fallbackByRecipient } = await supabase
      .from('email_logs')
      .select('campaign_lead_id,campaign_id,lead_id,inbox_id,to_email,sent_at')
      .eq('to_email', toEmail)
      .gte('sent_at', sentWindowStart)
      .lte('sent_at', sentWindowEnd)
      .order('sent_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (fallbackByRecipient) {
      return {
        campaign_lead_id: (fallbackByRecipient as any)?.campaign_lead_id ?? null,
        campaign_id: (fallbackByRecipient as any)?.campaign_id ?? null,
        lead_id: (fallbackByRecipient as any)?.lead_id ?? null,
        inbox_id: (fallbackByRecipient as any)?.inbox_id ?? null,
        to_email: toEmail,
        matched_by: 'recipient_window' as const,
        confidence: 'medium' as const,
      };
    }
  }

  return {
    campaign_lead_id: null,
    campaign_id: null,
    lead_id: null,
    inbox_id: null,
    to_email: evt.to_email ?? null,
    matched_by: null,
    confidence: 'low' as const,
  };
}

export async function ingestProviderEmailEvent(input: Record<string, unknown>) {
  const normalized = normalizeProviderEmailEvent(input);
  if (!normalized) {
    return { success: false, error: 'Unsupported payload. event_type and message_id are required.' };
  }

  const correlation = await resolveCorrelation(normalized);
  const dedupe_key = dedupeKeyForEvent(normalized);

  const { error: insertErr } = await supabase.from('email_tracking_events').insert({
    dedupe_key,
    event_type: normalized.event_type,
    provider_name: normalized.provider_name,
    provider_message_id: normalized.provider_message_id,
    campaign_id: correlation.campaign_id,
    campaign_lead_id: correlation.campaign_lead_id,
    lead_id: correlation.lead_id,
    inbox_id: correlation.inbox_id,
    from_email: normalized.from_email,
    to_email: correlation.to_email,
    event_at: normalized.event_at,
    matched: Boolean(correlation.campaign_lead_id || correlation.lead_id),
    raw_payload: {
      ...normalized.raw_payload,
      source: 'provider_webhook',
      matched_by: correlation.matched_by,
      correlation_confidence: correlation.confidence,
    },
  });

  if (insertErr) {
    if (String((insertErr as any)?.code ?? '') === '23505') {
      return {
        success: true,
        deduped: true,
      matched: Boolean(correlation.campaign_lead_id || correlation.lead_id),
      event_type: normalized.event_type,
      campaign_lead_id: correlation.campaign_lead_id,
      confidence: correlation.confidence,
    };
  }
    throw insertErr;
  }

  if (normalized.event_type === 'reply') {
    const replyResult = await ingestInboundReply({
      from_email: normalized.from_email ?? undefined,
      message: normalized.message ?? undefined,
      message_id: normalized.provider_message_id,
      received_at: normalized.event_at,
      leadId: correlation.lead_id ? String(correlation.lead_id) : undefined,
      source: 'provider_webhook',
      skipTrackingEvent: true,
    });

    return {
      success: true,
      deduped: false,
      matched: Boolean(correlation.campaign_lead_id || correlation.lead_id),
      event_type: normalized.event_type,
      campaign_lead_id: correlation.campaign_lead_id,
      lead_id: correlation.lead_id,
      reply: replyResult,
      confidence: correlation.confidence,
    };
  }

  return {
    success: true,
    deduped: false,
    matched: Boolean(correlation.campaign_lead_id || correlation.lead_id),
    event_type: normalized.event_type,
    campaign_lead_id: correlation.campaign_lead_id,
    lead_id: correlation.lead_id,
    to_email: correlation.to_email,
    provider_message_id: normalized.provider_message_id,
    confidence: correlation.confidence,
  };
}

function pixelTokenSecret(): string {
  return String(process.env.TRACKING_PIXEL_SECRET || process.env.JWT_SECRET || 'obaol-pixel-secret');
}

function signPixelPayload(raw: string): string {
  return createHash('sha256').update(`${raw}|${pixelTokenSecret()}`).digest('hex').slice(0, 20);
}

export function makePixelToken(payload: { campaignLeadId: string; campaignId: string; leadId: string; toEmail: string; sentAtIso: string }) {
  const raw = [
    payload.campaignLeadId,
    payload.campaignId,
    payload.leadId,
    payload.toEmail.toLowerCase(),
    payload.sentAtIso,
  ].join('|');
  const sig = signPixelPayload(raw);
  return Buffer.from(`${raw}|${sig}`).toString('base64url');
}

function decodePixelToken(token: string) {
  const decoded = Buffer.from(token, 'base64url').toString('utf8');
  const [campaignLeadId, campaignId, leadId, toEmail, sentAtIso, sig] = decoded.split('|');
  if (!campaignLeadId || !campaignId || !leadId || !toEmail || !sentAtIso || !sig) return null;
  const raw = [campaignLeadId, campaignId, leadId, toEmail, sentAtIso].join('|');
  if (signPixelPayload(raw) !== sig) return null;
  return {
    campaign_lead_id: campaignLeadId,
    campaign_id: campaignId,
    lead_id: leadId,
    to_email: toEmail.toLowerCase(),
    sent_at_iso: sentAtIso,
  };
}

export async function ingestPixelOpenEvent(token: string) {
  const decoded = decodePixelToken(String(token ?? ''));
  if (!decoded) {
    return { success: false, error: 'invalid_pixel_token' };
  }

  const eventAt = new Date().toISOString();
  const dedupe_key = createHash('sha256')
    .update(`pixel_open|${decoded.campaign_lead_id}|${eventAt.slice(0, 16)}`)
    .digest('hex');

  const { error } = await supabase.from('email_tracking_events').insert({
    dedupe_key,
    event_type: 'open',
    provider_name: 'pixel',
    provider_message_id: null,
    campaign_id: decoded.campaign_id,
    campaign_lead_id: decoded.campaign_lead_id,
    lead_id: decoded.lead_id,
    inbox_id: null,
    from_email: null,
    to_email: decoded.to_email,
    event_at: eventAt,
    matched: true,
    raw_payload: {
      source: 'pixel_fallback',
      confidence: 'medium',
      token_sent_at: decoded.sent_at_iso,
    },
  });

  if (error && String((error as any)?.code ?? '') !== '23505') {
    throw error;
  }

  return { success: true, deduped: String((error as any)?.code ?? '') === '23505' };
}

export async function getCampaignReplyOpenAnalytics(campaignId: string) {
  const [{ data: campaignLeads }, { data: emailLogRows }] = await Promise.all([
    supabase
      .from('campaign_leads')
      .select('id,status,status_reason,lead_id,leads:lead_id(email)')
      .eq('campaign_id', campaignId),
    supabase
      .from('email_logs')
      .select('campaign_lead_id,campaign_id,lead_id,inbox_id,to_email,provider_message_id,sent_at')
      .eq('campaign_id', campaignId)
      .eq('status', 'sent')
  ]);

  const sentRows = (emailLogRows ?? []) as any[];
  const campaignMessageIds = [...new Set(
    sentRows
      .map((row: any) => String(row?.provider_message_id ?? '').trim().toLowerCase())
      .filter(Boolean)
  )];
  const campaignRecipientEmails = [...new Set(
    sentRows
      .map((row: any) => cleanEmail(row?.to_email))
      .filter(Boolean)
  )] as string[];

  const [{ data: scopedEventRows }, { data: orphanEventRows }] = await Promise.all([
    supabase
      .from('email_tracking_events')
      .select('id,campaign_lead_id,event_type,event_at,provider_message_id,raw_payload,matched,campaign_id,to_email,lead_id,inbox_id')
      .eq('campaign_id', campaignId),
    supabase
      .from('email_tracking_events')
      .select('id,campaign_lead_id,event_type,event_at,provider_message_id,raw_payload,matched,campaign_id,to_email,lead_id,inbox_id')
      .is('campaign_id', null)
      .order('event_at', { ascending: false })
      .limit(2000)
  ]);

  const sentByMessageId = new Map<string, any>();
  for (const row of sentRows) {
    const messageId = String(row?.provider_message_id ?? '').trim().toLowerCase();
    if (messageId) sentByMessageId.set(messageId, row);
  }
  const sentByRecipient = new Map<string, any[]>();
  for (const row of sentRows) {
    const toEmail = cleanEmail(row?.to_email);
    if (!toEmail) continue;
    const list = sentByRecipient.get(toEmail) ?? [];
    list.push(row);
    sentByRecipient.set(toEmail, list);
  }
  for (const list of sentByRecipient.values()) {
    list.sort((a: any, b: any) => new Date(String(b?.sent_at ?? '')).getTime() - new Date(String(a?.sent_at ?? '')).getTime());
  }

  const mappedOrphanRows: any[] = [];
  const orphanBackfillUpdates: Array<{ id: string; campaign_id: string; campaign_lead_id: string; lead_id: string | null; inbox_id: string | null; to_email: string | null; matched: boolean; raw_payload: any }> = [];

  for (const rawRow of (orphanEventRows ?? []) as any[]) {
    const row = { ...rawRow };
    const messageId = String(row?.provider_message_id ?? '').trim().toLowerCase();
    const eventToEmail = cleanEmail(row?.to_email);
    const shouldConsiderByMessageId = Boolean(messageId) && campaignMessageIds.includes(messageId);
    const shouldConsiderByRecipient = Boolean(eventToEmail) && campaignRecipientEmails.includes(eventToEmail as string);
    if (!shouldConsiderByMessageId && !shouldConsiderByRecipient) continue;

    let matchedSent: any | null = null;
    let matchedBy: 'message_id' | 'recipient_window' | null = null;
    let confidence: 'high' | 'medium' = 'medium';

    if (shouldConsiderByMessageId && messageId) {
      matchedSent = sentByMessageId.get(messageId) ?? null;
      if (matchedSent) {
        matchedBy = 'message_id';
        confidence = 'high';
      }
    }

    if (!matchedSent && shouldConsiderByRecipient && eventToEmail) {
      const candidates = sentByRecipient.get(eventToEmail as string) ?? [];
      const eventAtMs = new Date(String(row?.event_at ?? '')).getTime();
      for (const candidate of candidates) {
        const sentMs = new Date(String(candidate?.sent_at ?? '')).getTime();
        if (!Number.isFinite(eventAtMs) || !Number.isFinite(sentMs)) continue;
        const deltaMs = eventAtMs - sentMs;
        if (deltaMs >= -(48 * 60 * 60 * 1000) && deltaMs <= (24 * 60 * 60 * 1000)) {
          matchedSent = candidate;
          matchedBy = 'recipient_window';
          confidence = 'medium';
          break;
        }
      }
    }

    if (!matchedSent) continue;

    row.campaign_id = matchedSent.campaign_id ?? campaignId;
    row.campaign_lead_id = matchedSent.campaign_lead_id ?? row.campaign_lead_id ?? null;
    row.lead_id = matchedSent.lead_id ?? row.lead_id ?? null;
    row.inbox_id = matchedSent.inbox_id ?? row.inbox_id ?? null;
    row.to_email = cleanEmail(row.to_email) ?? cleanEmail(matchedSent.to_email);
    row.matched = Boolean(row.campaign_lead_id || row.lead_id);
    row.raw_payload = {
      ...(row.raw_payload ?? {}),
      analytics_backfill: true,
      matched_by: matchedBy,
      correlation_confidence: confidence,
    };
    mappedOrphanRows.push(row);

    if (row.campaign_lead_id) {
      orphanBackfillUpdates.push({
        id: String(row.id),
        campaign_id: String(row.campaign_id),
        campaign_lead_id: String(row.campaign_lead_id),
        lead_id: row.lead_id ? String(row.lead_id) : null,
        inbox_id: row.inbox_id ? String(row.inbox_id) : null,
        to_email: row.to_email ?? null,
        matched: Boolean(row.matched),
        raw_payload: row.raw_payload ?? {},
      });
    }
  }

  if (orphanBackfillUpdates.length > 0) {
    await Promise.all(
      orphanBackfillUpdates.map((update) =>
        supabase
          .from('email_tracking_events')
          .update({
            campaign_id: update.campaign_id,
            campaign_lead_id: update.campaign_lead_id,
            lead_id: update.lead_id,
            inbox_id: update.inbox_id,
            to_email: update.to_email,
            matched: update.matched,
            raw_payload: update.raw_payload,
          })
          .eq('id', update.id)
      )
    );
  }

  const eventRows = [...((scopedEventRows ?? []) as any[]), ...mappedOrphanRows];

  const total = (campaignLeads ?? []).length;
  const sentSet = new Set(sentRows.map((r: any) => String(r.campaign_lead_id ?? '')).filter(Boolean));
  const deliveredSet = new Set<string>();
  const openedSet = new Set<string>();
  const repliedSet = new Set<string>();
  const hardBounceSet = new Set<string>();
  const softBounceSet = new Set<string>();
  const lastEventByLead = new Map<string, any>();

  for (const row of eventRows ?? []) {
    const leadId = String((row as any)?.campaign_lead_id ?? '');
    if (!leadId) continue;
    const eventType = String((row as any)?.event_type ?? '').toLowerCase();
    const eventAt = String((row as any)?.event_at ?? '');
    const prev = lastEventByLead.get(leadId);
    if (!prev || eventAt > String(prev.event_at ?? '')) {
      lastEventByLead.set(leadId, row);
    }
    if (eventType === 'delivered') deliveredSet.add(leadId);
    else if (eventType === 'open') openedSet.add(leadId);
    else if (eventType === 'reply') repliedSet.add(leadId);
    else if (eventType === 'bounced_hard') hardBounceSet.add(leadId);
    else if (eventType === 'bounced_soft') softBounceSet.add(leadId);
  }

  const inferredRepliedSet = new Set<string>(
    (campaignLeads ?? [])
      .filter((row: any) => String(row?.status ?? '').toLowerCase() === 'replied')
      .map((row: any) => String(row?.id ?? ''))
      .filter(Boolean)
  );
  const inferredOnlyRepliedSet = new Set<string>(
    [...inferredRepliedSet].filter((id) => !repliedSet.has(id))
  );

  const bouncedSet = new Set<string>([...hardBounceSet, ...softBounceSet]);
  const failedDeliveryByStatusSet = new Set<string>(
    (campaignLeads ?? [])
      .filter((r: any) => String(r?.status ?? '').toLowerCase() === 'failed')
      .map((r: any) => String(r?.id ?? ''))
      .filter(Boolean)
  );
  const deliveryFailedSet = new Set<string>([...hardBounceSet, ...failedDeliveryByStatusSet]);
  const sent = sentSet.size;
  const delivered = [...deliveredSet].filter((id) => sentSet.has(id)).length;
  const opened = [...openedSet].filter((id) => sentSet.has(id)).length;
  const replied = [...repliedSet].filter((id) => sentSet.has(id)).length;
  const bounced_hard = hardBounceSet.size;
  const bounced_soft = softBounceSet.size;
  const bounced_total = bouncedSet.size;
  const delivery_failed = deliveryFailedSet.size;
  const not_opened = Math.max(sent - opened, 0);
  const not_replied = Math.max(sent - replied, 0);
  const pending_outcome = Math.max(sent - delivered - bounced_total, 0);
  const unmatchedEventRows = (eventRows ?? []).filter((row: any) => {
    const matched = row?.matched;
    const hasCampaignLead = Boolean(String(row?.campaign_lead_id ?? ''));
    return matched === false || !hasCampaignLead;
  });
  const unmatched_events_count = unmatchedEventRows.length;
  const confirmedOpenEvents = eventRows.filter((row: any) => {
    const type = String(row?.event_type ?? '').toLowerCase();
    if (type !== 'open') return false;
    const source = String((row as any)?.raw_payload?.source ?? '');
    return source === 'pixel_fallback' || source === 'provider_webhook';
  }).length;
  const open_rate_visible = confirmedOpenEvents > 0;
  const open_rate_visibility_reason = open_rate_visible
    ? null
    : 'Open rate hidden until pixel/webhook-confirmed opens are captured.';
  const outcome_vs_step_mismatch = (campaignLeads ?? []).filter((lead: any) => {
    const clid = String(lead?.id ?? '');
    const stepStatus = String(lead?.status ?? '').toLowerCase();
    const stepSaysSent = stepStatus === 'completed' || stepStatus === 'replied';
    const realDelivered = deliveredSet.has(clid);
    const realBounced = bouncedSet.has(clid);
    return stepSaysSent && !realDelivered && !realBounced;
  }).length;

  const outcome_rows = (campaignLeads ?? []).map((lead: any) => {
    const clid = String(lead?.id ?? '');
    const lastEvent = lastEventByLead.get(clid);
    const eventType = String(lastEvent?.event_type ?? '').toLowerCase();
    let outcome = 'Not Sent';
    let source = 'none';
    let confidence: 'high' | 'medium' | 'low' = 'low';
    if (repliedSet.has(clid)) outcome = 'Replied';
    else if (inferredOnlyRepliedSet.has(clid)) outcome = 'Replied';
    else if (hardBounceSet.has(clid)) outcome = 'Hard Bounce';
    else if (softBounceSet.has(clid)) outcome = 'Soft Bounce';
    else if (openedSet.has(clid)) outcome = 'Opened';
    else if (deliveredSet.has(clid)) outcome = 'Delivered';
    else if (sentSet.has(clid)) outcome = 'Pending Outcome';
    if (lastEvent?.raw_payload?.source) source = String(lastEvent.raw_payload.source);
    const confRaw = String(lastEvent?.raw_payload?.correlation_confidence ?? lastEvent?.raw_payload?.confidence ?? '');
    if (confRaw === 'high' || confRaw === 'medium' || confRaw === 'low') confidence = confRaw;
    if (inferredOnlyRepliedSet.has(clid)) {
      source = 'campaign_status_fallback';
      confidence = 'low';
    }
    if (outcome === 'Pending Outcome' && source === 'none') confidence = 'low';

    return {
      campaign_lead_id: clid,
      lead_id: String(lead?.lead_id ?? ''),
      lead_email: String(lead?.leads?.email ?? ''),
      outcome,
      last_event_type: eventType || null,
      last_event_at: lastEvent?.event_at ?? null,
      provider_message_id: lastEvent?.provider_message_id ?? null,
      bounce_reason: lastEvent?.raw_payload?.reason ?? null,
      source,
      confidence,
    };
  });

  const spam_hints: string[] = [];
  if (bounce_rate(sent, bounced_total) >= 5) {
    spam_hints.push('Bounce rate is elevated; verify list quality and sender reputation.');
  }
  if (pending_outcome > 0 && delivered === 0 && sent > 0) {
    spam_hints.push('No delivery confirmations yet; webhook coverage or inbox placement may be limited.');
  }
  if (outcome_vs_step_mismatch > 0) {
    spam_hints.push('Some leads are step-completed but missing delivery/bounce events.');
  }
  if (unmatched_events_count > 0) {
    spam_hints.push(`Tracking correlation warning: ${unmatched_events_count} event(s) could not be mapped to a campaign lead.`);
  }
  if (!open_rate_visible) {
    spam_hints.push('Open tracking is currently unconfirmed for this campaign (no pixel/webhook open events yet).');
  }

  const lowConfidenceCount = outcome_rows.filter((row: any) => row.confidence === 'low').length;
  const trackedOutcomeCount = outcome_rows.filter((row: any) => String(row.outcome ?? '') !== 'Not Sent').length;
  const open_confidence: 'high' | 'medium' | 'low' = trackedOutcomeCount === 0 || sent === 0
    ? 'low'
    : !open_rate_visible
    ? 'low'
    : (lowConfidenceCount > 0 ? 'medium' : 'high');

  return {
    campaign_id: campaignId,
    total,
    sent,
    delivered,
    opened,
    not_opened,
    replied,
    not_replied,
    bounced_hard,
    bounced_soft,
    bounced_total,
    delivery_failed,
    pending_outcome,
    outcome_vs_step_mismatch,
    delivery_rate: sent > 0 ? Number(((delivered / sent) * 100).toFixed(2)) : 0,
    bounce_rate: sent > 0 ? Number(((bounced_total / sent) * 100).toFixed(2)) : 0,
    open_rate: sent > 0 ? Number(((opened / sent) * 100).toFixed(2)) : 0,
    open_rate_visible,
    open_rate_visibility_reason,
    open_confidence,
    metrics_data_freshness: new Date().toISOString(),
    reply_rate: sent > 0 ? Number(((replied / sent) * 100).toFixed(2)) : 0,
    inferred_replied_count: [...inferredOnlyRepliedSet].filter((id) => sentSet.has(id)).length,
    response_provenance: {
      replied_source: 'tracking_only',
      fallback_enabled: false,
    },
    diagnostics: {
      unmatched_events_count,
      unmatched_sample: unmatchedEventRows.slice(0, 5).map((row: any) => ({
        event_type: String(row?.event_type ?? ''),
        provider_message_id: String(row?.provider_message_id ?? ''),
        source: String((row?.raw_payload as any)?.source ?? 'provider_webhook'),
        correlation_confidence: String((row?.raw_payload as any)?.correlation_confidence ?? 'low'),
      })),
    },
    outcome_rows,
    spam_hints,
  };
}

function bounce_rate(sent: number, bounced: number): number {
  if (!sent) return 0;
  return Number(((bounced / sent) * 100).toFixed(2));
}

export async function getCampaignRepliesFeed(campaignId: string) {
  const { data } = await supabase
    .from('campaign_leads')
    .select(`
      id,
      campaign_id,
      lead_id,
      assigned_inbox_id,
      leads:lead_id (
        id,
        email,
        first_name,
        company,
        replied_at,
        reply_message,
        interest_status
      ),
      inboxes:assigned_inbox_id (
        email_address
      ),
      campaigns:campaign_id (
        id,
        name
      )
    `)
    .eq('campaign_id', campaignId)
    .eq('status', 'replied')
    .order('id', { ascending: false });

  return (data ?? []).map((row: any) => ({
    campaign_lead_id: row.id,
    campaign_id: row.campaign_id,
    campaign_name: row.campaigns?.name ?? null,
    lead_id: row.leads?.id ?? row.lead_id,
    email: row.leads?.email ?? null,
    first_name: row.leads?.first_name ?? null,
    company: row.leads?.company ?? null,
    replied_at: row.leads?.replied_at ?? null,
    reply_message: row.leads?.reply_message ?? null,
    interest_status: row.leads?.interest_status ?? 'unreviewed',
    inbox_email: row.inboxes?.email_address ?? null,
  }));
}
