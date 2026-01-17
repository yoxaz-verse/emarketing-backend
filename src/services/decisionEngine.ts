import { supabase } from '../supabase';

/**
 * READ-ONLY DECISION ENGINE
 * ------------------------
 * - Chooses whether an email can be sent
 * - Applies inbox limits, warmup, domain throttling
 * - Returns payload or null
 * - Does NOT mutate business state
 */
export async function getNextSend() {
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
  let dailyLimit = inbox.daily_limit;
  let hourlyLimit = inbox.hourly_limit;

  if (inbox.warmup_enabled) {
    const { data: warmup } = await supabase
      .from('warmup_schedule')
      .select('*')
      .eq('day', inbox.warmup_day)
      .single();

    if (warmup) {
      dailyLimit = warmup.daily_limit;
      hourlyLimit = warmup.hourly_limit;
    }
  }

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

      const inboxIds = domainInboxes?.map(i => i.id) ?? [];

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
