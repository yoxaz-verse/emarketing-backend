import { supabase } from '../supabase';
import {
  getSendingLimitsConfig,
  resolveInboxEffectiveLimits,
} from './sendingLimitsConfig.service';

/**
 * READ-ONLY DECISION ENGINE
 * ------------------------
 * - Chooses whether an email can be sent
 * - Applies inbox limits, warmup, domain throttling
 * - Returns payload or null
 * - Does NOT mutate business state
 */
export async function getNextSend() {
  const sendingLimits = await getSendingLimitsConfig();
  /**
   * 1. Pick one active inbox
   * (simple strategy for now; rotation can come later)
   */
  const { data: inbox } = await supabase
    .from('inboxes')
    .select('*')
    .eq('status', 'active')
    .eq('hard_paused', false)
    .limit(1)
    .single();

  if (!inbox) return null;

  /**
   * 2. Resolve inbox limits (warmup-aware)
   */
  const { dailyLimit, hourlyLimit } = resolveInboxEffectiveLimits(inbox, sendingLimits);

  /**
   * 3. DOMAIN-LEVEL THROTTLING (HARD SAFETY)
   */
  if (inbox.sending_domain) {
    const { data: domain } = await supabase
      .from('sending_domains')
      .select('*')
      .eq('domain', inbox.sending_domain)
      .single();

    if (domain) {
      // Fetch all inboxes under this domain
      const { data: domainInboxes } = await supabase
        .from('inboxes')
        .select('id')
        .eq('sending_domain', inbox.sending_domain);

      const inboxIds = domainInboxes?.map((i: { id: string }) => i.id) ?? [];

      if (inboxIds.length > 0) {
        const today = new Date().toISOString().slice(0, 10);

        const { count: domainSentToday } = await supabase
          .from('email_logs')
          .select('*', { count: 'exact', head: true })
          .eq('status', 'sent')
          .in('inbox_id', inboxIds)
          .gte('sent_at', today);

        if ((domainSentToday ?? 0) >= domain.daily_limit) {
          await supabase.from('system_events').insert({
            type: 'DOMAIN_THROTTLED',
            entity: 'domain',
            message: `Domain ${inbox.sending_domain} hit daily limit`
          });

          return null;
        }
      }
    }
  }

  /**
   * 4. INBOX DAILY LIMIT
   */
  const today = new Date().toISOString().slice(0, 10);

  const { count: sentToday } = await supabase
    .from('email_logs')
    .select('*', { count: 'exact', head: true })
    .eq('inbox_id', inbox.id)
    .eq('status', 'sent')
    .gte('sent_at', today);

  if ((sentToday ?? 0) >= dailyLimit) {
    await supabase.from('system_events').insert({
      type: 'SEND_SKIPPED',
      entity: 'inbox',
      entity_id: inbox.id,
      message: 'Inbox daily limit reached'
    });

    return null;
  }

  /**
   * 5. INBOX HOURLY LIMIT
   */
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();

  const { count: sentHour } = await supabase
    .from('email_logs')
    .select('*', { count: 'exact', head: true })
    .eq('inbox_id', inbox.id)
    .eq('status', 'sent')
    .gte('sent_at', hourAgo);

  if ((sentHour ?? 0) >= hourlyLimit) {
    return null;
  }

  /**
   * 6. FETCH NEXT LEAD (ASSIGNED + PENDING)
   */
  const { data: leadSequence } = await supabase
  .from('lead_sequences')
  .select(`
    id,
    lead_id,
    sequence_id,
    current_step,
    last_sent_at,
    completed,
    stopped,
    campaign_status,
    leads (*),
    sequences (*)
  `)
  .eq('completed', false)
  .eq('stopped', false)
  .eq('campaign_status', 'running')
  .order('last_sent_at', { ascending: true, nullsFirst: true })
  .limit(1)
  .single();

if (!leadSequence) return null;


const lead = leadSequence.leads;



const { data: step } = await supabase
  .from('sequence_steps')
  .select('*')
  .eq('sequence_id', leadSequence.sequence_id)
  .eq('step_number', leadSequence.current_step)
  .single();

if (!step) return null;

const leadEligibility = String(lead?.email_eligibility ?? '').toLowerCase();
if (leadEligibility === 'risky') {
  const riskyPercent = Math.max(0, Math.min(100, Number(sendingLimits.risky_daily_percent_limit ?? 20)));
  const allowedRiskyPerDay = Math.max(0, Math.floor((dailyLimit * riskyPercent) / 100));

  const { data: sentTodayLogs, error: sentTodayLogsError } = await supabase
    .from('email_logs')
    .select('lead_id')
    .eq('inbox_id', inbox.id)
    .eq('status', 'sent')
    .gte('sent_at', today);

  if (sentTodayLogsError) {
    return null;
  }

  const sentLeadIds = Array.from(
    new Set((sentTodayLogs ?? []).map((row: any) => String(row?.lead_id ?? '')).filter(Boolean))
  );

  let riskySentToday = 0;
  if (sentLeadIds.length > 0) {
    const { data: riskySentLeads } = await supabase
      .from('leads')
      .select('id')
      .in('id', sentLeadIds)
      .eq('email_eligibility', 'risky');
    riskySentToday = (riskySentLeads ?? []).length;
  }

  if (riskySentToday >= allowedRiskyPerDay) {
    await supabase.from('system_events').insert({
      type: 'RISKY_CAP_REACHED',
      entity: 'inbox',
      entity_id: inbox.id,
      message: `Risky send cap reached for inbox ${inbox.email_address}`,
      meta: {
        inbox_id: inbox.id,
        risky_percent_limit: riskyPercent,
        daily_limit: dailyLimit,
        allowed_risky_per_day: allowedRiskyPerDay,
        risky_sent_today: riskySentToday,
      },
    });
    return null;
  }
}

// If not first step, check delay
if (leadSequence.last_sent_at) {
  const nextAllowed = new Date(leadSequence.last_sent_at);
  nextAllowed.setDate(nextAllowed.getDate() + step.delay_days);

  if (new Date() < nextAllowed) {
    return null;
  }
}


  /**
   * 7. RETURN SEND PAYLOAD
   */
  return {
    inbox,
    lead,
    sequence_step_id: step.id,
    subject: step.subject,
    body: step.body
  };
}
