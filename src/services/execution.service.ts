import { supabase } from '../supabase';
import { decryptSecret } from '../utils/sendEncryption';
import { updateRow } from './crudService';
import nodemailer from 'nodemailer';


  
  
  export async function getNextCampaignExecutions(
    campaignId: string,
    batchSize: number
  ) {
    console.log("getNextCampaignExecutions");
    
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
  
    return data ?? [];
  }
  
  
  /**
   * Send campaign email for ONE campaign_lead
   * Idempotent-safe, deterministic, RLS-safe
   */
  export async function sendCampaignEmail(campaignLeadId: string) {
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
          email
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
        sending_domain_id
      `)
      .eq('id', campaignLead.assigned_inbox_id)
      .single();
  
    if (inboxError || !inbox) {
      throw new Error('Inbox not found');
    }
  
    /* -------------------------------------------------------
       3️⃣ Load SMTP account
    ------------------------------------------------------- */
    const { data: smtp, error: smtpError } = await supabase
      .from('smtp_accounts')
      .select(`
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
    const transporter = nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.encryption === 'ssl',
      auth: {
        user: smtp.username,
        pass: decryptSecret(smtp.password),
      },
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
  

  