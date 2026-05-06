import { supabase } from '../../supabase';
import { validateEmailAddress } from '../../services/email/emailValidation.pipeline';
import { markRunOutcome, type ValidationRunOutcome } from '../../services/validation/validation.run.service';

const MAX_RETRIES = 3;
const RETRY_DELAY_MINUTES = 15;

export type LeadValidationRow = {
  id: string;
  email: string;
  retry_count: number | null;
  validation_run_id?: string | null;
};

export async function processLeadValidation(lead: LeadValidationRow): Promise<ValidationRunOutcome> {
  const result = await validateEmailAddress(lead.email);

  if (result.retryable) {
    const retries = (lead.retry_count ?? 0) + 1;

    if (retries >= MAX_RETRIES) {
      await supabase
        .from('leads')
        .update({
          email_eligibility: 'risky',
          email_eligibility_reason: 'dns_timeout_retry_exhausted',
          validation_status: 'risky',
          disposable: result.disposable,
          role_based: result.roleBased,
          free_provider: result.freeProvider,
          risk_score: result.riskScore,
          suggestion: result.suggestion,
          mx_records: result.mxRecords,
          provider: result.provider,
          email_checked_at: new Date().toISOString(),
          eligibility_processing: false,
          permanently_failed: false,
          retry_count: retries,
        })
        .eq('id', lead.id);
      if (lead.validation_run_id) {
        await markRunOutcome(lead.validation_run_id, 'risky');
      }
      return 'risky';
    }

    await supabase
      .from('leads')
      .update({
        retry_count: retries,
        next_retry_at: new Date(Date.now() + RETRY_DELAY_MINUTES * 60 * 1000).toISOString(),
        eligibility_processing: false,
      })
      .eq('id', lead.id);
    if (lead.validation_run_id) {
      await markRunOutcome(lead.validation_run_id, 'failed');
    }
    return 'failed';
  }

  await supabase
    .from('leads')
    .update({
      email_eligibility: result.legacyStatus,
      email_eligibility_reason: result.reason,
      validation_status: result.validationStatus,
      disposable: result.disposable,
      role_based: result.roleBased,
      free_provider: result.freeProvider,
      risk_score: result.riskScore,
      suggestion: result.suggestion,
      mx_records: result.mxRecords,
      provider: result.provider,
      email_checked_at: new Date().toISOString(),
      eligibility_processing: false,
      permanently_failed: result.validationStatus === 'invalid',
    })
    .eq('id', lead.id);
  const outcome: ValidationRunOutcome =
    result.validationStatus === 'valid'
      ? 'valid'
      : result.validationStatus === 'risky'
      ? 'risky'
      : 'invalid';
  if (lead.validation_run_id) {
    await markRunOutcome(lead.validation_run_id, outcome);
  }
  return outcome;
}
