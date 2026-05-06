// src/worker/email/eligibility.worker.ts

import { supabase } from '../../supabase';
import { processLeadValidation, type LeadValidationRow } from './eligibility.processor';
import { logger } from '../../services/logging/logger';
import { markRunOutcome } from '../../services/validation/validation.run.service';

export async function runEligibilityWorker(
  limit: number = 100,
  runId?: string,
  preloadedLeads?: LeadValidationRow[]
): Promise<void> {
  let typedLeads = preloadedLeads ?? [];

  if (!preloadedLeads) {
    const { data: leads, error } = await supabase
      .from('leads')
      .select('id, email, retry_count')
      .eq('email_eligibility', 'pending')
      .or('eligibility_processing.is.null,eligibility_processing.eq.false')
      .limit(limit);

    if (error || !leads || leads.length === 0) {
      return;
    }
    typedLeads = leads as LeadValidationRow[];
  }

  if (runId) {
    typedLeads = typedLeads.map((lead) => ({ ...lead, validation_run_id: runId }));
  }

  const leadIds = typedLeads.map((l) => l.id);

  await supabase
    .from('leads')
    .update({ eligibility_processing: true })
    .in('id', leadIds);

  for (const lead of typedLeads) {
    try {
      await processLeadValidation(lead);
    } catch (err: any) {
      logger.error('legacy_worker_lead_processing_failed', {
        leadId: lead.id,
        error: err?.message ?? 'unknown_error',
      });

      await supabase
        .from('leads')
        .update({
          eligibility_processing: false,
        })
        .eq('id', lead.id);
      if (lead.validation_run_id) {
        await markRunOutcome(lead.validation_run_id, 'failed');
      }
    }
  }
}
