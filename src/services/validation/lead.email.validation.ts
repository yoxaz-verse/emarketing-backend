import { Request, Response } from 'express';
import { runEligibilityWorker } from '../../worker/email/eligibility.worker';
import { supabase } from '../../supabase';
import { getEmailValidationQueue } from '../../queue/emailValidation.queue';
import { logger } from '../logging/logger';
import {
  createValidationRun,
  getActiveValidationRun,
  getLatestValidationRun,
  listValidationRuns,
  toValidationRunStatusPayload,
  type ValidationRunMode,
} from './validation.run.service';

type LeadQueueRow = {
  id: string;
  email: string;
  retry_count: number | null;
};

const STALE_MINUTES = Math.max(1, Number(process.env.EMAIL_VALIDATION_STALE_MINUTES ?? 10));

function getStaleThresholdIso(): string {
  return new Date(Date.now() - STALE_MINUTES * 60 * 1000).toISOString();
}

async function recoverStaleProcessingRows(): Promise<number> {
  const staleThreshold = getStaleThresholdIso();
  const { data: staleRows, error: staleError } = await supabase
    .from('leads')
    .select('id')
    .eq('email_eligibility', 'pending')
    .eq('eligibility_processing', true)
    .lt('updated_at', staleThreshold)
    .limit(5000);

  if (staleError) {
    logger.warn('email_validation_stale_recovery_check_failed', { error: staleError.message });
    return 0;
  }

  const staleIds = (staleRows ?? []).map((row: any) => row.id);
  if (staleIds.length === 0) return 0;

  const { error: resetError } = await supabase
    .from('leads')
    .update({ eligibility_processing: false })
    .in('id', staleIds);

  if (resetError) {
    logger.error('email_validation_stale_recovery_reset_failed', { error: resetError.message });
    return 0;
  }

  logger.warn('email_validation_stale_recovered', {
    recoveredCount: staleIds.length,
    staleMinutes: STALE_MINUTES,
  });
  return staleIds.length;
}

async function fetchLeadsToQueue(mode: ValidationRunMode, limit: number): Promise<LeadQueueRow[]> {
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

  const { data: leads, error } = await supabase
    .from('leads')
    .select('id, email, retry_count')
    .eq('email_eligibility', 'pending')
    .or('eligibility_processing.is.null,eligibility_processing.eq.false')
    .limit(limit);

  if (error) throw error;
  return (leads as LeadQueueRow[]) ?? [];
}

async function enqueueLeads(mode: ValidationRunMode, limit: number, triggeredBy?: string | null) {
  const recovered = await recoverStaleProcessingRows();
  const { count: pendingCountPreFilter } = await supabase
    .from('leads')
    .select('id', { count: 'exact', head: true })
    .eq('email_eligibility', 'pending');

  const leads = await fetchLeadsToQueue(mode, limit);
  const run = await createValidationRun({
    type: mode,
    totalTargeted: leads.length,
    triggeredBy: triggeredBy ?? null,
    scope: { limit, queueMode: 'bullmq' },
  });

  if (leads.length === 0) {
    logger.info('email_validation_run_started', {
      mode,
      runId: run.id,
      queueMode: 'bullmq',
      pendingCountPreFilter: pendingCountPreFilter ?? 0,
      targetedCountPostFilter: leads.length,
      staleRecovered: recovered,
    });
    return { queued: 0, runId: run.id };
  }

  const leadIds = leads.map((lead) => lead.id);
  await supabase
    .from('leads')
    .update({ eligibility_processing: true })
    .in('id', leadIds);

  const queue = getEmailValidationQueue();
  await queue.addBulk(
    leads.map((lead) => ({
      name: 'validate-lead-email',
      data: { ...lead, validation_run_id: run.id },
      opts: {
        attempts: 3,
        backoff: {
          type: 'fixed',
          delay: 15000,
        },
        removeOnComplete: 1000,
        removeOnFail: 1000,
      },
    }))
  );

  logger.info('email_validation_run_started', {
    mode,
    runId: run.id,
    queueMode: 'bullmq',
    pendingCountPreFilter: pendingCountPreFilter ?? 0,
    targetedCountPostFilter: leads.length,
    staleRecovered: recovered,
  });

  return { queued: leads.length, runId: run.id };
}

async function runLegacyValidation(mode: ValidationRunMode, req: Request, staleRecovered: number) {
  const { count: pendingCountPreFilter } = await supabase
    .from('leads')
    .select('id', { count: 'exact', head: true })
    .eq('email_eligibility', 'pending');

  const leads = await fetchLeadsToQueue(mode, 1000);
  const run = await createValidationRun({
    type: mode,
    totalTargeted: leads.length,
    triggeredBy: req.headers.authorization ? 'authenticated_user' : null,
    scope: { limit: 1000, queueMode: 'legacy' },
  });

  if (leads.length > 0) {
    runEligibilityWorker(1000, run.id, leads);
  }

  logger.info('email_validation_run_started', {
    mode,
    runId: run.id,
    queueMode: 'legacy',
    pendingCountPreFilter: pendingCountPreFilter ?? 0,
    targetedCountPostFilter: leads.length,
    staleRecovered,
  });

  return {
    success: true,
    message: 'Email eligibility validation started',
    queued: leads.length,
    runId: run.id,
  };
}

export async function runEmailEligibilityValidation(req: Request, res: Response) {
  const mode = (String(req.body?.mode || 'pending') === 'rerun_failed' ? 'rerun_failed' : 'pending') as ValidationRunMode;
  const configuredMode = process.env.EMAIL_VALIDATION_QUEUE_MODE;
  const queueMode = configuredMode === 'bullmq' ? 'bullmq' : 'legacy';
  const bullmqFallbackToLegacy = process.env.EMAIL_VALIDATION_BULLMQ_FALLBACK_TO_LEGACY !== 'false';
  const activeRun = await getActiveValidationRun();

  if (activeRun) {
    return res.status(409).json({
      success: false,
      error: 'A validation run is already active. Please wait for completion.',
      activeRun,
    });
  }

  const staleRecovered = await recoverStaleProcessingRows();

  if (queueMode === 'bullmq') {
    try {
      const { queued, runId } = await enqueueLeads(mode, 1000, req.headers.authorization ? 'authenticated_user' : null);
      return res.json({
        success: true,
        message: 'Email eligibility validation queued',
        queued,
        runId,
      });
    } catch (error: any) {
      logger.error('email_validation_queue_failure', { error: error.message, fallbackToLegacy: bullmqFallbackToLegacy });
      if (!bullmqFallbackToLegacy) {
        return res.status(500).json({
          success: false,
          error: 'BullMQ mode failed. Check REDIS_URL/worker health or enable fallback.',
        });
      }

      try {
        const payload = await runLegacyValidation(mode, req, staleRecovered);
        return res.json(payload);
      } catch (legacyError: any) {
        logger.error('email_validation_legacy_fallback_failure', { error: legacyError.message });
        return res.status(500).json({
          success: false,
          error: 'Failed to run legacy validation fallback',
        });
      }
    }
  }

  try {
    const payload = await runLegacyValidation(mode, req, staleRecovered);
    return res.json(payload);
  } catch (error: any) {
    logger.error('email_validation_legacy_failure', { error: error.message });
    return res.status(500).json({
      success: false,
      error: 'Failed to run legacy validation worker',
    });
  }
}

export async function resetStuckAndRerunValidation(req: Request, res: Response) {
  req.body = {
    ...(req.body ?? {}),
    mode: 'pending',
  };
  return runEmailEligibilityValidation(req, res);
}

export async function getEmailValidationRunStatus(_req: Request, res: Response) {
  const staleRecovered = await recoverStaleProcessingRows();
  const run = await getLatestValidationRun();
  const staleThreshold = getStaleThresholdIso();
  const recentUpdatesThreshold = new Date(Date.now() - 2 * 60 * 1000).toISOString();
  const [
    pendingAvailableResult,
    processingNowResult,
    stuckProcessingResult,
    recentUpdatesResult,
    lastProgressResult,
    totalLeadsResult,
  ] = await Promise.all([
    supabase
      .from('leads')
      .select('id', { count: 'exact', head: true })
      .eq('email_eligibility', 'pending')
      .or('eligibility_processing.is.null,eligibility_processing.eq.false'),
    supabase
      .from('leads')
      .select('id', { count: 'exact', head: true })
      .eq('email_eligibility', 'pending')
      .eq('eligibility_processing', true),
    supabase
      .from('leads')
      .select('id', { count: 'exact', head: true })
      .eq('email_eligibility', 'pending')
      .eq('eligibility_processing', true)
      .lt('updated_at', staleThreshold),
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
      .select('id', { count: 'exact', head: true }),
  ]);

  return res.json({
    success: true,
    ...toValidationRunStatusPayload(run),
    availability: {
      pendingAvailable: pendingAvailableResult.count ?? 0,
      processingNow: processingNowResult.count ?? 0,
      stuckProcessing: stuckProcessingResult.count ?? 0,
      recentUpdates: recentUpdatesResult.count ?? 0,
      lastProgressAt: (lastProgressResult as any)?.data?.email_checked_at ?? null,
      totalLeads: totalLeadsResult.count ?? 0,
      staleRecovered,
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
