import { supabase } from '../../supabase';
import { validateEmailAddress } from '../../services/email/emailValidation.pipeline';
import { logger } from '../../services/logging/logger';
import { markRunOutcome, touchValidationRun, type ValidationRunOutcome } from '../../services/validation/validation.run.service';

const MAX_RETRIES = 3;
const RETRY_DELAY_MINUTES = 15;
const PER_LEAD_TIMEOUT_MS = Math.max(5_000, Number(process.env.EMAIL_VALIDATION_PER_LEAD_TIMEOUT_MS ?? 25_000));

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
      const { error: retryExhaustedError } = await supabase
        .from('leads')
        .update({
          email_eligibility: 'risky',
          email_eligibility_reason: 'dns_timeout_retry_exhausted',
          email_checked_at: new Date().toISOString(),
          eligibility_processing: false,
          permanently_failed: false,
          retry_count: retries,
        })
        .eq('id', lead.id);
      if (retryExhaustedError) {
        throw retryExhaustedError;
      }
      if (lead.validation_run_id) {
        await markRunOutcome(lead.validation_run_id, 'risky');
      }
      return 'risky';
    }

    const { error: retryableError } = await supabase
      .from('leads')
      .update({
        retry_count: retries,
        next_retry_at: new Date(Date.now() + RETRY_DELAY_MINUTES * 60 * 1000).toISOString(),
        eligibility_processing: false,
      })
      .eq('id', lead.id);
    if (retryableError) {
      throw retryableError;
    }
    if (lead.validation_run_id) {
      await markRunOutcome(lead.validation_run_id, 'failed');
    }
    return 'failed';
  }

  const { error: finalUpdateError } = await supabase
    .from('leads')
    .update({
      email_eligibility: result.legacyStatus,
      email_eligibility_reason: result.reason,
      email_checked_at: new Date().toISOString(),
      eligibility_processing: false,
      permanently_failed: result.validationStatus === 'invalid',
    })
    .eq('id', lead.id);
  if (finalUpdateError) {
    throw finalUpdateError;
  }
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

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(new Error(`lead_processing_timeout_${timeoutMs}ms`));
    }, timeoutMs);

    promise
      .then((value) => {
        clearTimeout(timeoutId);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timeoutId);
        reject(error);
      });
  });
}

export async function processLeadValidationSafely(lead: LeadValidationRow): Promise<ValidationRunOutcome> {
  const startedAt = Date.now();
  logger.info('lead_processing_started', {
    leadId: lead.id,
    runId: lead.validation_run_id ?? null,
    timeoutMs: PER_LEAD_TIMEOUT_MS,
  });

  if (lead.validation_run_id) {
    await touchValidationRun(lead.validation_run_id);
  }

  try {
    const outcome = await withTimeout(processLeadValidation(lead), PER_LEAD_TIMEOUT_MS);
    logger.info('lead_processing_completed', {
      leadId: lead.id,
      runId: lead.validation_run_id ?? null,
      outcome,
      durationMs: Date.now() - startedAt,
    });
    return outcome;
  } catch (error: any) {
    const message = String(error?.message ?? 'unknown_error');
    const retries = (lead.retry_count ?? 0) + 1;

    const { error: failureUpdateError } = await supabase
      .from('leads')
      .update({
        eligibility_processing: false,
        retry_count: retries,
        next_retry_at: new Date(Date.now() + RETRY_DELAY_MINUTES * 60 * 1000).toISOString(),
        email_eligibility_reason: message.startsWith('lead_processing_timeout_')
          ? 'processing_timeout_retryable'
          : 'processing_failed_retryable',
      })
      .eq('id', lead.id);

    if (failureUpdateError) {
      logger.error('lead_processing_failure_update_failed', {
        leadId: lead.id,
        runId: lead.validation_run_id ?? null,
        originalError: message,
        updateError: failureUpdateError.message,
      });
    }

    if (lead.validation_run_id) {
      await markRunOutcome(lead.validation_run_id, 'failed');
    }

    if (message.startsWith('lead_processing_timeout_')) {
      logger.warn('lead_processing_timeout', {
        leadId: lead.id,
        runId: lead.validation_run_id ?? null,
        durationMs: Date.now() - startedAt,
        error: message,
      });
    } else {
      logger.error('lead_processing_failed', {
        leadId: lead.id,
        runId: lead.validation_run_id ?? null,
        durationMs: Date.now() - startedAt,
        error: message,
      });
    }

    return 'failed';
  }
}
