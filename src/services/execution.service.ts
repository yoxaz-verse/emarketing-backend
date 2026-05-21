import { supabase } from '../supabase';
import { decryptSecret } from '../utils/sendEncryption';
import { updateRow } from './crudService';
import { createSmtpTransport } from './email/smtpTransport';
import {
  getSendingLimitsConfig,
  resolveInboxEffectiveLimits,
  isNowWithinSendingSchedule,
} from './sendingLimitsConfig.service';

const RUNNER_WINDOW_TIMEZONE = 'Asia/Kolkata';
const RUNNER_WINDOW_START_HOUR = 9;
const RUNNER_WINDOW_END_HOUR = 18;
const DEFAULT_STALE_PROCESSING_TIMEOUT_MINUTES = 10;

function isWithinRunnerWindow(now: Date = new Date()): boolean {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: RUNNER_WINDOW_TIMEZONE,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(now);

  const hourPart = parts.find((part) => part.type === 'hour')?.value ?? '00';
  const minutePart = parts.find((part) => part.type === 'minute')?.value ?? '00';
  const totalMinutes = (Number(hourPart) * 60) + Number(minutePart);

  return totalMinutes >= RUNNER_WINDOW_START_HOUR * 60
    && totalMinutes < RUNNER_WINDOW_END_HOUR * 60;
}

export async function getCampaignExecutionWakeState(lastSeenVersion?: string | null) {
  const { data, error } = await supabase
    .from('campaigns')
    .select('updated_at')
    .not('updated_at', 'is', null)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    const code = String((error as any)?.code ?? '');
    const message = String((error as any)?.message ?? '');
    const missingUpdatedAt = code === '42703' || message.includes('campaigns.updated_at');

    if (missingUpdatedAt) {
      const migrationError: Error & { statusCode?: number } = new Error(
        'Campaign wake-check requires migration 20260512_add_campaigns_updated_at_for_wake_check.sql. Apply migration and restart backend.'
      );
      migrationError.statusCode = 503;
      throw migrationError;
    }

    throw error;
  }

  const version = String((data as any)?.updated_at ?? '0');
  const normalizedLastSeen = String(lastSeenVersion ?? '').trim();

  return {
    version,
    changed_since: normalizedLastSeen.length === 0 ? true : version !== normalizedLastSeen,
    within_window: isWithinRunnerWindow(),
    timezone: RUNNER_WINDOW_TIMEZONE,
    window_start: '09:00',
    window_end: '18:00',
  };
}


  
  
export async function getNextCampaignExecutions(
    campaignId: string,
    batchSize: number
  ) {
    const config = await getSendingLimitsConfig();
    const scheduleGate = isNowWithinSendingSchedule(config);
    if (!scheduleGate.allowed) {
      console.log('[CLAIM EXECUTIONS SKIPPED: SCHEDULE]', {
        campaign_id: campaignId,
        batch_size: batchSize,
        reason: scheduleGate.reason ?? 'schedule_not_allowed',
      });
      return [];
    }

    const staleRecovery = await requeueStaleProcessingLeads({
      campaignId,
      olderThanMinutes: DEFAULT_STALE_PROCESSING_TIMEOUT_MINUTES,
    });

    const [queuedCount, processingCount] = await Promise.all([
      countCampaignLeadsByStatus(campaignId, 'queued'),
      countCampaignLeadsByStatus(campaignId, 'processing'),
    ]);
    
    const { data, error } = await supabase.rpc(
      'claim_campaign_executions',
      {
        p_campaign_id: campaignId,
        p_limit: batchSize
      }
    );
    console.log("Outside Function");

    if (error) {
      console.error('[CLAIM EXECUTIONS ERROR]', error);
      throw error;
    }

    const executions = data ?? [];
    console.log('[CLAIM EXECUTIONS DIAGNOSTICS]', {
      campaign_id: campaignId,
      batch_size: batchSize,
      queued_count: queuedCount,
      processing_count: processingCount,
      stale_requeued_count: staleRecovery.requeued,
      claimed_count: Array.isArray(executions) ? executions.length : 0,
    });
    
    return executions;
  }

type RequeueStaleProcessingInput = {
  campaignId?: string;
  olderThanMinutes?: number;
};

export async function requeueStaleProcessingLeads(input: RequeueStaleProcessingInput = {}) {
  const campaignId = typeof input.campaignId === 'string' && input.campaignId.trim().length > 0
    ? input.campaignId.trim()
    : undefined;
  const requestedMinutes = Number(input.olderThanMinutes);
  const olderThanMinutes = Number.isFinite(requestedMinutes) && requestedMinutes > 0
    ? Math.floor(requestedMinutes)
    : DEFAULT_STALE_PROCESSING_TIMEOUT_MINUTES;

  const cutoffIso = new Date(Date.now() - (olderThanMinutes * 60 * 1000)).toISOString();

  let scopedQuery = supabase
    .from('campaign_leads')
    .select('id, campaign_id')
    .eq('status', 'processing')
    .lt('processing_at', cutoffIso);

  if (campaignId) {
    scopedQuery = scopedQuery.eq('campaign_id', campaignId);
  }

  const { data: staleRows, error: staleRowsError } = await scopedQuery;
  if (staleRowsError) {
    throw staleRowsError;
  }

  const staleIds = (staleRows ?? []).map((row: any) => String(row.id)).filter(Boolean);
  const scanned = staleIds.length;

  if (staleIds.length === 0) {
    return {
      scanned: 0,
      requeued: 0,
      campaign_id: campaignId ?? null,
      older_than_minutes: olderThanMinutes,
      cutoff_iso: cutoffIso,
    };
  }

  const { data: updatedRows, error: updateError } = await supabase
    .from('campaign_leads')
    .update({
      status: 'queued',
      status_reason: 'requeued_processing_timeout',
      execution_id: null,
      processing_at: null,
    })
    .in('id', staleIds)
    .eq('status', 'processing')
    .select('id');

  if (updateError) {
    throw updateError;
  }

  const requeued = (updatedRows ?? []).length;

  await supabase.from('system_events').insert({
    type: 'PROCESSING_REQUEUED_TIMEOUT',
    entity: 'campaign_leads',
    entity_id: campaignId ?? null,
    message: `Requeued ${requeued} stale processing lead(s).`,
    meta: {
      campaign_id: campaignId ?? null,
      scanned,
      requeued,
      older_than_minutes: olderThanMinutes,
      cutoff_iso: cutoffIso,
    },
  });

  return {
    scanned,
    requeued,
    campaign_id: campaignId ?? null,
    older_than_minutes: olderThanMinutes,
    cutoff_iso: cutoffIso,
  };
}

async function countCampaignLeadsByStatus(campaignId: string, status: string): Promise<number> {
  const { count, error } = await supabase
    .from('campaign_leads')
    .select('id', { count: 'exact', head: true })
    .eq('campaign_id', campaignId)
    .eq('status', status);

  if (error) {
    throw error;
  }

  return Number(count ?? 0);
}
  
  
  /**
   * Send campaign email for ONE campaign_lead
   * Idempotent-safe, deterministic, RLS-safe
   */
export async function sendCampaignEmail(campaignLeadId: string) {
  const config = await getSendingLimitsConfig();
  const scheduleGate = isNowWithinSendingSchedule(config);
  if (!scheduleGate.allowed) {
    return {
      skipped: true,
      reason: scheduleGate.reason ?? 'schedule_not_allowed',
    };
  }

  /* -------------------------------------------------------
       1️⃣ Load campaign_lead (EXECUTION STATE ONLY)
    ------------------------------------------------------- */
    const { data: campaignLead, error: leadError } = await supabase
      .from('campaign_leads')
      .select(`
        id,
        status,
        current_step,
        assigned_inbox_id,
        leads:lead_id (
          id,
          email,
          email_eligibility
        )
      `)
      .eq('id', campaignLeadId)
      .single();
  
    if (leadError || !campaignLead) {
      throw new Error('Campaign lead not found');
    }
  
    if (campaignLead.status !== 'processing') {
      throw new Error('Campaign lead is not in processing state');
    }
  
    if (!campaignLead.assigned_inbox_id) {
      throw new Error('Campaign lead has no assigned inbox');
    }
  
    /* -------------------------------------------------------
       2️⃣ Load inbox (INFRASTRUCTURE)
    ------------------------------------------------------- */
    const { data: inbox, error: inboxError } = await supabase
      .from('inboxes')
      .select(`
        id,
        email_address,
        smtp_account_id,
        sending_domain_id,
        daily_limit,
        hourly_limit,
        warmup_enabled,
        warmup_day
      `)
      .eq('id', campaignLead.assigned_inbox_id)
      .single();
  
    if (inboxError || !inbox) {
      throw new Error('Inbox not found');
    }

    const leadEligibility = String(campaignLead?.leads?.email_eligibility ?? '').toLowerCase();
    if (leadEligibility === 'risky') {
      const { dailyLimit } = resolveInboxEffectiveLimits(inbox as any, config);
      const riskyPercent = Math.max(0, Math.min(100, Number(config.risky_daily_percent_limit ?? 20)));
      const allowedRiskyPerDay = Math.max(0, Math.floor((dailyLimit * riskyPercent) / 100));
      const today = new Date().toISOString().slice(0, 10);

      const { data: sentTodayLogs, error: sentTodayLogsError } = await supabase
        .from('email_logs')
        .select('lead_id')
        .eq('inbox_id', inbox.id)
        .eq('status', 'sent')
        .gte('sent_at', today);

      if (sentTodayLogsError) {
        throw sentTodayLogsError;
      }

      const sentLeadIds = Array.from(
        new Set((sentTodayLogs ?? []).map((row: any) => String(row?.lead_id ?? '')).filter(Boolean))
      );

      let riskySentToday = 0;
      if (sentLeadIds.length > 0) {
        const { data: riskySentLeads, error: riskySentLeadsError } = await supabase
          .from('leads')
          .select('id')
          .in('id', sentLeadIds)
          .eq('email_eligibility', 'risky');

        if (riskySentLeadsError) {
          throw riskySentLeadsError;
        }
        riskySentToday = (riskySentLeads ?? []).length;
      }

      if (riskySentToday >= allowedRiskyPerDay) {
        await supabase.from('campaign_leads').update({
          status: 'paused',
          status_reason: 'risky_daily_cap_reached',
        }).eq('id', campaignLeadId).eq('status', 'processing');

        await supabase.from('system_events').insert({
          type: 'RISKY_CAP_REACHED',
          entity: 'inbox',
          entity_id: inbox.id,
          message: `Risky send cap reached for inbox ${inbox.email_address}`,
          meta: {
            campaign_lead_id: campaignLeadId,
            inbox_id: inbox.id,
            risky_percent_limit: riskyPercent,
            daily_limit: dailyLimit,
            allowed_risky_per_day: allowedRiskyPerDay,
            risky_sent_today: riskySentToday,
          },
        });

        return {
          skipped: true,
          reason: 'risky_daily_cap_reached',
          inbox_id: inbox.id,
          allowed_risky_per_day: allowedRiskyPerDay,
          risky_sent_today: riskySentToday,
        };
      }
    }
  
    /* -------------------------------------------------------
       3️⃣ Load SMTP account
    ------------------------------------------------------- */
    const { data: smtp, error: smtpError } = await supabase
      .from('smtp_accounts')
      .select(`
        provider,
        host,
        port,
        username,
        password,
        encryption
      `)
      .eq('id', inbox.smtp_account_id)
      .single();
  
    if (smtpError || !smtp) {
      throw new Error('SMTP account missing for inbox');
    }
  
    /* -------------------------------------------------------
       4️⃣ Load sequence step (CONTENT)
    ------------------------------------------------------- */
    const { data: stepRow, error: stepError } = await supabase
      .from('campaign_leads')
      .select(`
        current_step,
        campaigns:campaign_id (
          sequences:sequence_id (
            sequence_steps (
              step_number,
              subject,
              body
            )
          )
        )
      `)
      .eq('id', campaignLeadId)
      .single();
  
    if (stepError || !stepRow) {
      throw new Error('Failed to load sequence');
    }
  
    const steps = stepRow.campaigns.sequences.sequence_steps;
    const step = steps.find(
      (s: any) => s.step_number === stepRow.current_step
    );
  
    if (!step) {
      throw new Error('Sequence step not found');
    }
  
    /* -------------------------------------------------------
       5️⃣ Send email
    ------------------------------------------------------- */
    const transporter = createSmtpTransport({
      provider: smtp.provider,
      host: smtp.host,
      port: smtp.port,
      username: smtp.username,
      password: decryptSecret(smtp.password),
      encryption: smtp.encryption,
    });
  
    const info = await transporter.sendMail({
      from: `"${inbox.email_address}" <${inbox.email_address}>`,
      to: campaignLead.leads.email,
      subject: step.subject,
      html: step.body,
    });
  
    /* -------------------------------------------------------
       6️⃣ Log event
    ------------------------------------------------------- */
    await supabase.from('system_events').insert({
      type: 'email_sent',
      entity_id: campaignLeadId,
      meta: {
        message_id: info.messageId,
        inbox_id: inbox.id,
        to: campaignLead.leads.email,
      },
    });
  
    return {
      message_id: info.messageId,
      to: campaignLead.leads.email,
    };
  }
  
  
  
  
  
  
/**
 * STEP SUCCESS
 */
export async function markCampaignLeadSent(
  campaignLeadId: string,
  reason: string = 'sent_successfully'
) {
  const { data, error } = await supabase
    .from('campaign_leads')
    .select('id, status, assigned_inbox_id, current_step')
    .eq('id', campaignLeadId)
    .single();

  if (error || !data) {
    throw new Error('Campaign lead not found');
  }

  if (data.status !== 'processing') {
    throw new Error('Campaign lead is not in processing state');
  }

  const inboxId = data.assigned_inbox_id;

  await supabase
    .from('campaign_leads')
    .update({
      status: 'completed',
      status_reason: reason,
      last_sent_at: new Date().toISOString(),
      current_step: data.current_step + 1,
    })
    .eq('id', campaignLeadId)
    .eq('status', 'processing');

  await supabase.from('system_events').insert({
    type: 'email_sent',
    entity_id: campaignLeadId,
    meta: { inbox_id: inboxId, reason },
  });
}




/**
 * STEP FAILURE
 */
export async function markCampaignLeadFailed(
  campaignLeadId: string,
  reason: string,
  code: string = 'unknown'
) {
  const { data, error } = await supabase
    .from('campaign_leads')
    .select('id, status, assigned_inbox_id')
    .eq('id', campaignLeadId)
    .single();

  if (error || !data) {
    throw new Error('Campaign lead not found');
  }

  if (data.status !== 'processing') {
    throw new Error('Campaign lead is not in processing state');
  }

  const inboxId = data.assigned_inbox_id;

  // 1️⃣ Update campaign lead
  await supabase
    .from('campaign_leads')
    .update({
      status: 'failed',
      status_reason: reason,
      status_code: code,
    })
    .eq('id', campaignLeadId)
    .eq('status', 'processing');

  // 2️⃣ Update inbox failure counters
  const { data: inbox } = await supabase
    .from('inboxes')
    .select('consecutive_failures')
    .eq('id', inboxId)
    .single();

  const newFailureCount = (inbox?.consecutive_failures ?? 0) + 1;

  const inboxUpdate: any = {
    failed_count: supabase.raw('failed_count + 1'),
    consecutive_failures: newFailureCount,
  };

  if (newFailureCount >= 3) {
    inboxUpdate.is_paused = true;
    inboxUpdate.paused_reason = 'Too many consecutive failures';
  }

  await supabase
    .from('inboxes')
    .update(inboxUpdate)
    .eq('id', inboxId);

  // 3️⃣ Log system event
  await supabase.from('system_events').insert({
    type: 'email_failed',
    entity_id: campaignLeadId,
    meta: {
      inbox_id: inboxId,
      status: 'failed',
      reason,
      code,
    },
  });
}


export async function completeCampaignIfDone(campaignId: string) {
  /**
   * 1. Load campaign + sequence length
   */
  const { data: campaign, error: campaignError } = await supabase
    .from('campaigns')
    .select(`
      id,
      status,
      sequences:sequence_id (
        sequence_steps (
          step_number
        )
      )
    `)
    .eq('id', campaignId)
    .single();

  if (campaignError || !campaign) {
    throw new Error('Campaign not found');
  }

  if (campaign.status !== 'running') {
    return false;
  }

  const steps = campaign.sequences.sequence_steps;
  const maxStep = Math.max(...steps.map((s: any) => s.step_number));

  /**
   * 2. Check if any leads still need execution
   */
  const { data: pendingLeads, error: leadError } = await supabase
    .from('campaign_leads')
    .select('id')
    .eq('campaign_id', campaignId)
    .in('status', ['queued', 'processing'])
    .limit(1);

  if (leadError) {
    throw leadError;
  }

  // If there are still active leads, campaign is NOT complete
  if (pendingLeads.length > 0) {
    return false;
  }

  /**
   * 3. Check if any lead still has steps remaining
   */
  const { data: incompleteSteps, error: stepError } = await supabase
    .from('campaign_leads')
    .select('id, current_step')
    .eq('campaign_id', campaignId)
    .lt('current_step', maxStep + 1)
    .not('status', 'in', '(failed,replied)')
    .limit(1);

  if (stepError) {
    throw stepError;
  }

  if (incompleteSteps.length > 0) {
    return false;
  }

  /**
   * 4. Mark campaign as completed
   */
  const { error: updateError } = await supabase
    .from('campaigns')
    .update({
      status: 'completed',
      completed_at: new Date().toISOString(),
    })
    .eq('id', campaignId)
    .eq('status', 'running');

  if (updateError) {
    throw updateError;
  }

  /**
   * 5. Log system event
   */
  await supabase.from('system_events').insert({
    type: 'campaign_completed',
    entity_id: campaignId,
  });

  return true;
}


export async function resetInboxCounters(
  resetHourly: boolean,
  resetDaily: boolean
) {
  const updates: any = {};

  if (resetHourly) {
    updates.hourly_send_count = 0;
  }

  if (resetDaily) {
    updates.daily_send_count = 0;
  }

  await supabase.from('inboxes').update(updates);
}

export async function requeueRiskyPausedLeads() {
  const { data: runningCampaigns, error: campaignError } = await supabase
    .from('campaigns')
    .select('id')
    .eq('status', 'running');

  if (campaignError) {
    throw campaignError;
  }

  const campaignIds = (runningCampaigns ?? []).map((row: any) => String(row.id)).filter(Boolean);
  if (campaignIds.length === 0) {
    return { updated: 0 };
  }

  const { data: pausedLeads, error: pausedLeadsError } = await supabase
    .from('campaign_leads')
    .select('id')
    .in('campaign_id', campaignIds)
    .eq('status', 'paused')
    .eq('status_reason', 'risky_daily_cap_reached');

  if (pausedLeadsError) {
    throw pausedLeadsError;
  }

  const leadIds = (pausedLeads ?? []).map((row: any) => String(row.id)).filter(Boolean);
  if (leadIds.length === 0) {
    return { updated: 0 };
  }

  const { error: updateError } = await supabase
    .from('campaign_leads')
    .update({
      status: 'queued',
      status_reason: null,
    })
    .in('id', leadIds);

  if (updateError) {
    throw updateError;
  }

  await supabase.from('system_events').insert({
    type: 'RISKY_REQUEUE_DAILY',
    entity: 'campaign_leads',
    message: `Daily risky-cap recovery requeued ${leadIds.length} lead(s).`,
    meta: {
      updated: leadIds.length,
      campaign_count: campaignIds.length,
    },
  });

  return { updated: leadIds.length };
}




/**
 * AUTO COMPLETE CAMPAIGN
 */
export async function maybeCompleteCampaign(campaignId: string) {
  const { count } = await supabase
    .from('campaign_leads')
    .select('*', { count: 'exact', head: true })
    .eq('campaign_id', campaignId)
    .in('status', ['queued', 'processing', 'paused']);

  if (count === 0) {
    await updateRow('campaigns', campaignId, {
      status: 'completed',
      completed_at: new Date().toISOString(),
    });

    await supabase.from('system_events').insert({
      type: 'campaign_completed',
      entity: 'campaign',
      entity_id: campaignId,
      message: 'Campaign completed automatically',
    });
  }
}






  type BounceType = 'hard' | 'soft' | 'reply';
  
  export async function handleBounce(
    email:string,
    type:'hard'|'soft',
    reason?:string
  ) {
    const { data: inbox } = await supabase
      .from('inboxes')
      .select('id,consecutive_failures')
      .eq('email_address',email)
      .single();
  
    if (!inbox) return;
  
    let updates:any = {
      failed_count: supabase.raw('failed_count + 1')
    };
  
    if (type === 'hard') {
      updates.is_paused = true;
      updates.paused_reason = 'Hard bounce';
    } else {
      updates.consecutive_failures = inbox.consecutive_failures + 1;
      if (updates.consecutive_failures >= 3) {
        updates.is_paused = true;
        updates.paused_reason = 'Repeated soft bounces';
      }
    }
  
    await supabase.from('inboxes').update(updates).eq('id', inbox.id);
  }
  
  export async function handleReply(payload:any) {
    const email = payload.from;
  
    await supabase
      .from('campaign_leads')
      .update({ status:'replied' })
      .eq('lead_email',email)
      .in('status',['queued','processing']);
  }
  

  
