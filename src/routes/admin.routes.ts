import { Router } from 'express';
import {
  pauseInbox,
  hardPauseInbox,
  resumeInbox,
  disableSequence,
  enableSequence,
  listOperators
} from '../services/adminService.js';
import {
  getSendingLimitsConfig,
  updateSendingLimitsConfig,
} from '../services/sendingLimitsConfig.service.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { supabase } from '../supabase.js';

const router = Router();

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

/**
 * Admin-only area
 */
router.use(requireAuth('admin'));

/**
 * Inbox controls
 */
router.post('/inbox/:id/pause', async (req, res) => {
  await pauseInbox(req.params.id, req.body?.reason);
  res.json({ success: true });
});

router.post('/inbox/:id/hard-pause', async (req, res) => {
  await hardPauseInbox(req.params.id, req.body?.reason);
  res.json({ success: true });
});

router.post('/inbox/:id/resume', async (req, res) => {
  await resumeInbox(req.params.id);
  res.json({ success: true });
});

/**
 * Sequence controls
 */
router.post('/sequence/:id/disable', async (req, res) => {
  await disableSequence(req.params.id);
  res.json({ success: true });
});

router.post('/sequence/:id/enable', async (req, res) => {
  await enableSequence(req.params.id);
  res.json({ success: true });
});

/**
 * Operators list (Admin only)
 */
router.get('/operators', async (_req, res) => {
  const { data, error } = await listOperators();

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  res.json(data);
});

router.get('/sending-limits', async (_req, res) => {
  try {
    const config = await getSendingLimitsConfig();
    res.json(config);
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? 'Failed to load sending limits' });
  }
});

router.put('/sending-limits', async (req, res) => {
  try {
    const config = await updateSendingLimitsConfig(req.body);
    res.json(config);
  } catch (err: any) {
    res.status(400).json({ error: err.message ?? 'Failed to update sending limits' });
  }
});

router.get('/validation/monitor', async (_req, res) => {
  try {
    const recentWindowIso = new Date(Date.now() - 2 * 60 * 1000).toISOString();

    const [
      latestRunResult,
      runHistoryResult,
      pendingResult,
      processingNowResult,
      recentUpdatesResult,
      reasonRowsResult,
      totalLeadsResult,
    ] = await Promise.all([
      supabase
        .from('validation_runs')
        .select('*')
        .order('started_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabase
        .from('validation_runs')
        .select('*')
        .order('started_at', { ascending: false })
        .limit(5),
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
        .gte('email_checked_at', recentWindowIso),
      supabase
        .from('leads')
        .select('email_eligibility_reason')
        .not('email_eligibility_reason', 'is', null)
        .limit(5000),
      supabase
        .from('leads')
        .select('id', { count: 'exact', head: true }),
    ]);

    const latestRun = latestRunResult.data ?? null;
    const history = runHistoryResult.data ?? [];
    const runAgeSeconds = latestRun?.started_at
      ? Math.max(0, Math.round((Date.now() - new Date(latestRun.started_at).getTime()) / 1000))
      : 0;

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
      .slice(0, 10)
      .map(([reason, count]) => ({ reason, count }));

    const mostFailedStepEntry = Object.entries(stepFailureCounts)
      .sort((a, b) => b[1] - a[1])[0] as [StepKey, number] | undefined;

    const processingNow = processingNowResult.count ?? 0;
    const recentUpdates = recentUpdatesResult.count ?? 0;

    const diagnosis: string[] = [];
    if (processingNow > 0 && recentUpdates === 0 && runAgeSeconds >= 120) {
      diagnosis.push(`Run appears stalled: ${processingNow} processing rows with no recent updates in last 2 minutes.`);
    }

    if (mostFailedStepEntry && mostFailedStepEntry[1] > 0) {
      diagnosis.push(`Most failures are at ${STEP_LABELS[mostFailedStepEntry[0]]}.`);
    }

    if (diagnosis.length === 0) {
      diagnosis.push('Validation pipeline appears healthy based on current telemetry.');
    }

    return res.json({
      success: true,
      run: latestRun,
      history,
      metrics: {
        runAgeSeconds,
        pendingAvailable: pendingResult.count ?? 0,
        processingNow,
        recentUpdates,
        totalLeads: totalLeadsResult.count ?? 0,
      },
      reasons: {
        topReasons,
        stepFailureCounts,
        mostFailedStep: mostFailedStepEntry
          ? { key: mostFailedStepEntry[0], label: STEP_LABELS[mostFailedStepEntry[0]], count: mostFailedStepEntry[1] }
          : null,
      },
      runtime: {
        executionMode: 'inline_sync',
        flow: 'basic_step_validation',
      },
      diagnosis,
    });
  } catch (err: any) {
    return res.status(500).json({
      success: false,
      error: err?.message ?? 'Failed to load validation monitor',
    });
  }
});

export default router;
