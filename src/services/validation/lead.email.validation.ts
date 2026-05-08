import { Request, Response } from 'express';
import { runEligibilityWorker } from '../../worker/email/eligibility.worker';
import { supabase } from '../../supabase';
import { logger } from '../logging/logger';
import {
  createValidationRun,
  getActiveValidationRun,
  getLatestValidationRun,
  listValidationRuns,
  markRunFailed,
  toValidationRunStatusPayload,
  type ValidationRunMode,
} from './validation.run.service';

type LeadQueueRow = {
  id: string;
  email: string;
  retry_count: number | null;
};

type StepKey = 'step_1_syntax' | 'step_2_provider' | 'step_3_risk' | 'step_4_finalize';

const STEP_LABELS: Record<StepKey, string> = {
  step_1_syntax: 'Step 1 - Email Syntax',
  step_2_provider: 'Step 2 - Provider & Domain',
  step_3_risk: 'Step 3 - Risk Filters',
  step_4_finalize: 'Step 4 - Final Decision',
};

function getStepFromReason(reason: string | null | undefined): StepKey {
  const normalized = String(reason ?? '').toLowerCase();
  if (!normalized) return 'step_4_finalize';

  if (normalized === 'invalid_syntax') return 'step_1_syntax';
  if (normalized === 'no_mx' || normalized.startsWith('dns_timeout')) return 'step_2_provider';
  if (
    normalized === 'free_provider' ||
    normalized === 'role_based' ||
    normalized === 'disposable_domain' ||
    normalized === 'domain_typo_suspected'
  ) {
    return 'step_3_risk';
  }

  return 'step_4_finalize';
}

function applyPendingQueueReadyFilter(query: any) {
  return query
    .eq('email_eligibility', 'pending')
    .or('eligibility_processing.is.null,eligibility_processing.eq.false');
}

export function isBlankEligibility(value: unknown): boolean {
  return value == null || String(value).trim() === '';
}

export function hasNonEmptyEmail(value: unknown): boolean {
  return value != null && String(value).trim() !== '';
}

export function shouldNormalizeLeadEligibility(row: { email?: unknown; email_eligibility?: unknown }): boolean {
  return hasNonEmptyEmail(row.email) && isBlankEligibility(row.email_eligibility);
}

async function normalizeLegacyPendingEligibility(): Promise<number> {
  const { data: candidates, error: fetchError } = await supabase
    .from('leads')
    .select('id, email, email_eligibility')
    .or('email_eligibility.is.null,email_eligibility.eq.')
    .not('email', 'is', null)
    .neq('email', '')
    .limit(5000);

  if (fetchError) {
    logger.warn('email_validation_normalization_check_failed', { error: fetchError.message });
    return 0;
  }

  const idsToNormalize = (candidates ?? [])
    .filter((row: any) => shouldNormalizeLeadEligibility(row))
    .map((row: any) => row.id);

  if (idsToNormalize.length === 0) return 0;

  const { error: updateError } = await supabase
    .from('leads')
    .update({
      email_eligibility: 'pending',
      eligibility_processing: false,
      retry_count: 0,
      permanently_failed: false,
    })
    .in('id', idsToNormalize);

  if (updateError) {
    logger.warn('email_validation_normalization_update_failed', { error: updateError.message });
    return 0;
  }

  logger.info('email_validation_normalization_applied', {
    normalizedCount: idsToNormalize.length,
  });
  return idsToNormalize.length;
}

async function resetInProgressRows(): Promise<number> {
  const { data: processingRows, error: processingError } = await supabase
    .from('leads')
    .select('id')
    .eq('email_eligibility', 'pending')
    .eq('eligibility_processing', true)
    .limit(5000);

  if (processingError) {
    logger.warn('email_validation_reset_in_progress_check_failed', { error: processingError.message });
    return 0;
  }

  const ids = (processingRows ?? []).map((row: any) => row.id);
  if (ids.length === 0) return 0;

  const { error: resetError } = await supabase
    .from('leads')
    .update({ eligibility_processing: false })
    .in('id', ids);

  if (resetError) {
    logger.warn('email_validation_reset_in_progress_failed', { error: resetError.message });
    return 0;
  }

  logger.warn('email_validation_reset_in_progress_applied', {
    recoveredCount: ids.length,
  });
  return ids.length;
}

async function fetchLeadsToValidate(mode: ValidationRunMode, limit: number): Promise<LeadQueueRow[]> {
  if (mode === 'rerun_failed') {
    const { data: failedLeads, error: failedError } = await supabase
      .from('leads')
      .select('id')
      .eq('permanently_failed', true)
      .limit(limit);

    if (failedError) throw failedError;
    const failedIds = (failedLeads ?? []).map((l: any) => l.id);

    if (failedIds.length > 0) {
      await supabase
        .from('leads')
        .update({
          email_eligibility: 'pending',
          eligibility_processing: false,
          permanently_failed: false,
          retry_count: 0,
          email_eligibility_reason: null,
        })
        .in('id', failedIds);
    }
  }

  const { data: leads, error } = await applyPendingQueueReadyFilter(
    supabase
      .from('leads')
      .select('id, email, retry_count')
  ).limit(limit);

  if (error) throw error;
  return (leads as LeadQueueRow[]) ?? [];
}

async function startEmailEligibilityValidation(
  req: Request,
  options: { bypassActiveRunCheck: boolean }
): Promise<{ success: boolean; message: string; queued: number; runId: string }> {
  const mode = (String(req.body?.mode || 'pending') === 'rerun_failed' ? 'rerun_failed' : 'pending') as ValidationRunMode;

  if (!options.bypassActiveRunCheck) {
    const activeRun = await getActiveValidationRun();
    if (activeRun) {
      const err = new Error('A validation run is currently active. Please wait for completion.') as Error & {
        statusCode?: number;
        activeRun?: any;
      };
      err.statusCode = 409;
      err.activeRun = activeRun;
      throw err;
    }
  }

  const normalizedCount = await normalizeLegacyPendingEligibility();
  const { count: pendingCountPreFilter } = await supabase
    .from('leads')
    .select('id', { count: 'exact', head: true })
    .eq('email_eligibility', 'pending');

  const leads = await fetchLeadsToValidate(mode, 1000);
  const run = await createValidationRun({
    type: mode,
    totalTargeted: leads.length,
    triggeredBy: req.headers.authorization ? 'authenticated_user' : null,
    scope: { limit: 1000, executionMode: 'inline_sync' },
  });

  if (leads.length > 0) {
    await runEligibilityWorker(1000, run.id, leads);
  }

  logger.info('email_validation_run_started', {
    mode,
    runId: run.id,
    executionMode: 'inline_sync',
    pendingCountPreFilter: pendingCountPreFilter ?? 0,
    targetedCountPostFilter: leads.length,
    normalizedCount,
  });

  return {
    success: true,
    message: 'Email eligibility validation finished in basic one-by-one mode',
    queued: leads.length,
    runId: run.id,
  };
}

export async function runEmailEligibilityValidation(req: Request, res: Response) {
  try {
    const payload = await startEmailEligibilityValidation(req, {
      bypassActiveRunCheck: false,
    });
    return res.json(payload);
  } catch (error: any) {
    const statusCode = Number(error?.statusCode ?? 500);
    return res.status(statusCode).json({
      success: false,
      error: error?.message ?? 'Failed to start validation run',
      ...(error?.activeRun ? { activeRun: error.activeRun } : {}),
    });
  }
}

export async function resetStuckAndRerunValidation(req: Request, res: Response) {
  const resetCount = await resetInProgressRows();
  logger.warn('email_validation_reset_and_rerun_requested', {
    resetCount,
  });

  req.body = {
    ...(req.body ?? {}),
    mode: 'pending',
  };

  return runEmailEligibilityValidation(req, res);
}

export async function forceUnlockAndRerunValidation(req: Request, res: Response) {
  const mode = (String(req.body?.mode || 'pending') === 'rerun_failed' ? 'rerun_failed' : 'pending') as ValidationRunMode;
  const activeRun = await getActiveValidationRun();
  const previousRunId = activeRun?.id ?? null;

  if (activeRun) {
    await markRunFailed(activeRun.id, 'manual_reset_in_progress_from_leads_ui');
  }

  const resetCount = await resetInProgressRows();
  logger.warn('email_validation_manual_unlock_applied', {
    previousRunId,
    resetCount,
    requestedMode: mode,
  });

  req.body = {
    ...(req.body ?? {}),
    mode,
  };

  try {
    const payload = await startEmailEligibilityValidation(req, {
      bypassActiveRunCheck: true,
    });
    return res.json({
      ...payload,
      previousRunId,
      newRunId: payload.runId,
      message: `Reset in-progress state completed.${previousRunId ? ` Closed run ${previousRunId}.` : ''}`,
    });
  } catch (error: any) {
    const statusCode = Number(error?.statusCode ?? 500);
    return res.status(statusCode).json({
      success: false,
      error: error?.message ?? 'Reset in-progress and rerun failed',
      previousRunId,
    });
  }
}

export async function getEmailValidationRunStatus(_req: Request, res: Response) {
  const run = await getLatestValidationRun();
  const recentUpdatesThreshold = new Date(Date.now() - 2 * 60 * 1000).toISOString();

  const [
    pendingAvailableResult,
    processingNowResult,
    stuckProcessingResult,
    recentUpdatesResult,
    lastProgressResult,
    lastProcessedLeadResult,
    totalLeadsResult,
    reasonRowsResult,
  ] = await Promise.all([
    applyPendingQueueReadyFilter(
      supabase
        .from('leads')
        .select('id', { count: 'exact', head: true })
    ),
    supabase
      .from('leads')
      .select('id', { count: 'exact', head: true })
      .eq('email_eligibility', 'pending')
      .eq('eligibility_processing', true),
    supabase
      .from('leads')
      .select('id', { count: 'exact', head: true })
      .eq('eligibility_processing', true),
    supabase
      .from('leads')
      .select('id', { count: 'exact', head: true })
      .gte('email_checked_at', recentUpdatesThreshold),
    supabase
      .from('leads')
      .select('email_checked_at')
      .eq('email_eligibility', 'pending')
      .order('email_checked_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from('leads')
      .select('email_checked_at')
      .not('email_checked_at', 'is', null)
      .order('email_checked_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from('leads')
      .select('id', { count: 'exact', head: true }),
    supabase
      .from('leads')
      .select('email_eligibility_reason')
      .not('email_eligibility_reason', 'is', null)
      .limit(5000),
  ]);

  const reasonCounts: Record<string, number> = {};
  const stepFailureCounts: Record<StepKey, number> = {
    step_1_syntax: 0,
    step_2_provider: 0,
    step_3_risk: 0,
    step_4_finalize: 0,
  };

  for (const row of reasonRowsResult.data ?? []) {
    const reason = String((row as any)?.email_eligibility_reason ?? 'unknown');
    reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1;
    const step = getStepFromReason(reason);
    stepFailureCounts[step] += 1;
  }

  const topReasons = Object.entries(reasonCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([reason, count]) => ({ reason, count }));

  const mostFailedStepEntry = Object.entries(stepFailureCounts)
    .sort((a, b) => b[1] - a[1])[0] as [StepKey, number] | undefined;

  const runAgeSeconds =
    run?.started_at
      ? Math.max(0, Math.round((Date.now() - new Date(run.started_at).getTime()) / 1000))
      : 0;

  return res.json({
    success: true,
    ...toValidationRunStatusPayload(run),
    availability: {
      pendingAvailable: pendingAvailableResult.count ?? 0,
      processingNow: processingNowResult.count ?? 0,
      stuckProcessing: stuckProcessingResult.count ?? 0,
      recentUpdates: recentUpdatesResult.count ?? 0,
      lastProgressAt: (lastProgressResult as any)?.data?.email_checked_at ?? null,
      lastProcessedLeadAt: (lastProcessedLeadResult as any)?.data?.email_checked_at ?? null,
      runAgeSeconds,
      totalLeads: totalLeadsResult.count ?? 0,
      topReasons,
      stepFailureCounts,
      mostFailedStep: mostFailedStepEntry
        ? { key: mostFailedStepEntry[0], label: STEP_LABELS[mostFailedStepEntry[0]], count: mostFailedStepEntry[1] }
        : null,
    },
  });
}

export async function getEmailValidationRunHistory(req: Request, res: Response) {
  const limit = Number(req.query.limit ?? 5);
  const runs = await listValidationRuns(limit);
  return res.json({
    success: true,
    runs,
  });
}
