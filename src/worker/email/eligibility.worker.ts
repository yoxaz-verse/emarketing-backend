// src/worker/email/eligibility.worker.ts

import { supabase } from '../../supabase';
import { checkEmailEligibility } from '../../services/email/eligibility.service';

const MAX_RETRIES = 3;
const RETRY_DELAY_MINUTES = 15;

export async function runEligibilityWorker(
  limit: number = 100
): Promise<void> {
console.log("Run ELigibility");

  /**
   * 1️⃣ Fetch pending & unlocked leads
   */
  type LeadRow = {
    id: string;
    email: string;
    retry_count: number | null;
  };
  
  const { data: leads, error } = await supabase
    .from('leads')
    .select('id, email, retry_count')
    .eq('email_eligibility', 'pending')
    .eq('eligibility_processing', false)
    .limit(limit);
  
  if (error || !leads || leads.length === 0) {
    return;
  }
  
  const typedLeads = leads as LeadRow[];
  
  const leadIds = typedLeads.map(l => l.id);
  /**
   * 2️⃣ Lock leads for processing
   */
  await supabase
    .from('leads')
    .update({ eligibility_processing: true })
    .in('id', leadIds);

  /**
   * 3️⃣ Process each lead independently
   */
  for (const lead of leads) {
    try {
      const result = await checkEmailEligibility(lead.email);

      await supabase
        .from('leads')
        .update({
          email_eligibility: result.status,
          email_eligibility_reason: result.reason,
          email_checked_at: new Date().toISOString(),
          eligibility_processing: false,
          permanently_failed: result.status === 'blocked'
        })
        .eq('id', lead.id);

    } catch (err) {
      /**
       * 4️⃣ Retry handling
       */
      const retries = (lead.retry_count ?? 0) + 1;

      if (retries >= MAX_RETRIES) {
        await supabase
          .from('leads')
          .update({
            email_eligibility: 'blocked',
            email_eligibility_reason: 'max_retries_exceeded',
            permanently_failed: true,
            eligibility_processing: false
          })
          .eq('id', lead.id);
      } else {
        await supabase
          .from('leads')
          .update({
            retry_count: retries,
            next_retry_at: new Date(
              Date.now() + RETRY_DELAY_MINUTES * 60 * 1000
            ).toISOString(),
            eligibility_processing: false
          })
          .eq('id', lead.id);
      }
    }
  }
}
