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
import { encryptSocialSecret } from '../utils/socialIntegrationEncryption.js';

const router = Router();
type SocialPlatform = 'linkedin' | 'meta' | 'reddit' | 'telegram' | 'whatsapp';

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
router.get('/operators', async (req, res) => {
  try {
    const { data, error } = await listOperators();
    if (error) {
      console.error('[ADMIN_OPERATORS_LIST_ERROR]', {
        role: req.auth?.role ?? null,
        type: req.auth?.type ?? null,
        message: error.message ?? 'Unknown error',
      });
      return res.status(500).json({ error: error.message });
    }

    console.info('[ADMIN_OPERATORS_LIST_OK]', {
      role: req.auth?.role ?? null,
      type: req.auth?.type ?? null,
      count: Array.isArray(data) ? data.length : 0,
    });
    res.json(data ?? []);
  } catch (err: any) {
    console.error('[ADMIN_OPERATORS_LIST_EXCEPTION]', {
      role: req.auth?.role ?? null,
      type: req.auth?.type ?? null,
      message: err?.message ?? 'Unknown exception',
    });
    return res.status(500).json({ error: err?.message ?? 'Failed to load operators' });
  }
});

const SOCIAL_PLATFORMS: SocialPlatform[] = ['linkedin', 'meta', 'reddit', 'telegram', 'whatsapp'];

function isSocialPlatform(value: string): value is SocialPlatform {
  return SOCIAL_PLATFORMS.includes(value as SocialPlatform);
}

function requiredFieldsByPlatform(platform: SocialPlatform): string[] {
  if (platform === 'linkedin') return ['client_id', 'client_secret', 'redirect_uri'];
  if (platform === 'meta') return ['app_id', 'app_secret', 'redirect_uri'];
  if (platform === 'reddit') return ['client_id', 'client_secret', 'redirect_uri', 'user_agent'];
  if (platform === 'telegram') return ['bot_token', 'chat_id'];
  return ['phone_number_id', 'business_account_id', 'access_token'];
}

function extractConfig(platform: SocialPlatform, input: Record<string, unknown>) {
  const trim = (v: unknown) => String(v ?? '').trim();
  if (platform === 'linkedin') {
    const scopes = Array.isArray(input.scopes)
      ? input.scopes.map((s) => String(s ?? '').trim()).filter(Boolean)
      : [];
    return {
      client_id: trim(input.client_id),
      secret: trim(input.client_secret),
      redirect_uri: trim(input.redirect_uri),
      scopes: scopes.length > 0 ? scopes : ['w_member_social', 'r_liteprofile'],
      metadata: {},
    };
  }

  if (platform === 'meta') {
    return {
      client_id: trim(input.app_id),
      secret: trim(input.app_secret),
      redirect_uri: trim(input.redirect_uri),
      scopes: [],
      metadata: {
        page_access_token: trim(input.page_access_token),
        business_account_id: trim(input.business_account_id),
      },
    };
  }

  if (platform === 'reddit') {
    return {
      client_id: trim(input.client_id),
      secret: trim(input.client_secret),
      redirect_uri: trim(input.redirect_uri),
      scopes: [],
      metadata: {
        user_agent: trim(input.user_agent),
      },
    };
  }

  if (platform === 'telegram') {
    return {
      client_id: '',
      secret: trim(input.bot_token),
      redirect_uri: '',
      scopes: [],
      metadata: {
        chat_id: trim(input.chat_id),
      },
    };
  }

  return {
    client_id: trim(input.phone_number_id),
    secret: trim(input.access_token),
    redirect_uri: '',
    scopes: [],
    metadata: {
      business_account_id: trim(input.business_account_id),
      phone_number_id: trim(input.phone_number_id),
    },
  };
}

function missingRequired(platform: SocialPlatform, source: Record<string, string>): string[] {
  return requiredFieldsByPlatform(platform).filter((key) => !String(source[key] ?? '').trim());
}

function nonSecretFields(platform: SocialPlatform, row: any, hasSecret: boolean): Record<string, string> {
  const metadata = (row?.metadata && typeof row.metadata === 'object') ? row.metadata : {};
  const fields: Record<string, string> = {};

  if (platform === 'linkedin') {
    fields.client_id = String(row.client_id ?? '');
    fields.redirect_uri = String(row.redirect_uri ?? '');
    fields.client_secret = hasSecret ? '***' : '';
    return fields;
  }

  if (platform === 'meta') {
    fields.app_id = String(row.client_id ?? '');
    fields.redirect_uri = String(row.redirect_uri ?? '');
    fields.app_secret = hasSecret ? '***' : '';
    fields.page_access_token = String((metadata as any).page_access_token ?? '');
    fields.business_account_id = String((metadata as any).business_account_id ?? '');
    return fields;
  }

  if (platform === 'reddit') {
    fields.client_id = String(row.client_id ?? '');
    fields.redirect_uri = String(row.redirect_uri ?? '');
    fields.client_secret = hasSecret ? '***' : '';
    fields.user_agent = String((metadata as any).user_agent ?? '');
    return fields;
  }

  if (platform === 'telegram') {
    fields.bot_token = hasSecret ? '***' : '';
    fields.chat_id = String((metadata as any).chat_id ?? '');
    return fields;
  }

  fields.phone_number_id = String((metadata as any).phone_number_id ?? row.client_id ?? '');
  fields.business_account_id = String((metadata as any).business_account_id ?? '');
  fields.access_token = hasSecret ? '***' : '';
  return fields;
}

function isSocialAppSchemaMismatch(error: any): boolean {
  const code = String(error?.code ?? '');
  const message = String(error?.message ?? '').toLowerCase();
  return (
    code === '42P01' ||
    code === '42703' ||
    message.includes('social_operator_oauth_apps') ||
    message.includes('does not exist') ||
    message.includes('schema cache')
  );
}

async function handleGetSocialApp(req: any, res: any, platformRaw: string, operatorIdRaw: string, scopeRaw?: string) {
  try {
    const platform = String(platformRaw ?? '').trim().toLowerCase();
    if (!isSocialPlatform(platform)) return res.status(400).json({ error: 'Unsupported platform' });

    const scope = String(scopeRaw ?? 'operator').trim().toLowerCase();
    const isGlobalScope = scope === 'global';
    const operatorId = String(operatorIdRaw ?? '').trim();

    if (!isGlobalScope && !operatorId) return res.status(400).json({ error: 'operator_id is required' });

    const query = isGlobalScope
      ? supabase
        .from('social_global_oauth_apps')
        .select('*')
        .eq('platform_code', platform)
      : supabase
        .from('social_operator_oauth_apps')
        .select('*')
        .eq('operator_id', operatorId)
        .eq('platform_code', platform);

    const { data, error } = await query.maybeSingle();

    if (error && error.code !== 'PGRST116') throw error;
    if (!data) {
      console.info('[ADMIN_SOCIAL_APP_READ_OK]', {
        role: req.auth?.role ?? null,
        operatorId,
        platform,
        configured: false,
      });
      return res.json({
        configured: false,
        operator_id: isGlobalScope ? null : operatorId,
        platform_code: platform,
        scope: isGlobalScope ? 'global' : 'operator',
        required_missing: requiredFieldsByPlatform(platform),
      });
    }

    const row = data as any;
    const hasSecret = Boolean(String(row.client_secret_encrypted ?? '').trim());
    const responseFields = nonSecretFields(platform, row, hasSecret);
    const requiredMissing = missingRequired(platform, responseFields);
    console.info('[ADMIN_SOCIAL_APP_READ_OK]', {
      role: req.auth?.role ?? null,
      operatorId,
      platform,
      configured: requiredMissing.length === 0,
      missingCount: requiredMissing.length,
    });

    return res.json({
      configured: requiredMissing.length === 0,
      operator_id: isGlobalScope ? null : operatorId,
      platform_code: platform,
      scope: isGlobalScope ? 'global' : 'operator',
      required_missing: requiredMissing,
      fields: responseFields,
      active: Boolean(row.active),
      updated_at: row.updated_at,
    });
  } catch (err: any) {
    if (isSocialAppSchemaMismatch(err)) {
      return res.status(500).json({
        error: 'social_operator_oauth_apps schema is not ready. Apply social app migrations and restart backend.',
      });
    }
    console.error('[ADMIN_SOCIAL_APP_READ_ERROR]', {
      role: req.auth?.role ?? null,
      platform: platformRaw ?? null,
      message: err?.message ?? 'Unknown error',
    });
    return res.status(500).json({ error: err?.message ?? 'Failed to read social app config' });
  }
}

async function handlePutSocialApp(req: any, res: any, platformRaw: string, body: any, scopeRaw?: string) {
  try {
    const platform = String(platformRaw ?? '').trim().toLowerCase();
    if (!isSocialPlatform(platform)) return res.status(400).json({ error: 'Unsupported platform' });

    const scope = String(scopeRaw ?? body?.scope ?? 'operator').trim().toLowerCase();
    const isGlobalScope = scope === 'global';
    const operatorId = String(body?.operator_id ?? '').trim();
    if (!isGlobalScope && !operatorId) return res.status(400).json({ error: 'operator_id is required' });

    const extracted = extractConfig(platform, (body ?? {}) as Record<string, unknown>);
    const checkMap: Record<string, string> = {};
    if (platform === 'linkedin') {
      checkMap.client_id = extracted.client_id;
      checkMap.client_secret = extracted.secret;
      checkMap.redirect_uri = extracted.redirect_uri;
    } else if (platform === 'meta') {
      checkMap.app_id = extracted.client_id;
      checkMap.app_secret = extracted.secret;
      checkMap.redirect_uri = extracted.redirect_uri;
    } else if (platform === 'reddit') {
      checkMap.client_id = extracted.client_id;
      checkMap.client_secret = extracted.secret;
      checkMap.redirect_uri = extracted.redirect_uri;
      checkMap.user_agent = String((extracted.metadata as any).user_agent ?? '');
    } else if (platform === 'telegram') {
      checkMap.bot_token = extracted.secret;
      checkMap.chat_id = String((extracted.metadata as any).chat_id ?? '');
    } else {
      checkMap.phone_number_id = String((extracted.metadata as any).phone_number_id ?? '');
      checkMap.business_account_id = String((extracted.metadata as any).business_account_id ?? '');
      checkMap.access_token = extracted.secret;
    }

    const requiredMissing = missingRequired(platform, checkMap);
    if (requiredMissing.length > 0) {
      return res.status(400).json({ error: `Missing required fields: ${requiredMissing.join(', ')}` });
    }

    const payload = {
      platform_code: platform,
      client_id: extracted.client_id || null,
      client_secret_encrypted: encryptSocialSecret(extracted.secret),
      redirect_uri: extracted.redirect_uri || null,
      scopes: extracted.scopes,
      metadata: extracted.metadata ?? {},
      active: true,
      updated_at: new Date().toISOString(),
    };

    const { error } = isGlobalScope
      ? await supabase
        .from('social_global_oauth_apps')
        .upsert(payload, { onConflict: 'platform_code' })
      : await supabase
        .from('social_operator_oauth_apps')
        .upsert({ ...payload, operator_id: operatorId }, { onConflict: 'operator_id,platform_code' });

    if (error) throw error;

    console.info('[ADMIN_SOCIAL_APP_UPSERT_OK]', {
      role: req.auth?.role ?? null,
      operatorId: isGlobalScope ? 'global' : operatorId,
      platform,
      scope: isGlobalScope ? 'global' : 'operator',
      requiredMissingCount: requiredMissing.length,
    });

    return res.json({ success: true });
  } catch (err: any) {
    if (isSocialAppSchemaMismatch(err)) {
      return res.status(500).json({
        error: 'social_operator_oauth_apps schema is not ready. Apply social app migrations and restart backend.',
      });
    }
    console.error('[ADMIN_SOCIAL_APP_UPSERT_ERROR]', {
      role: req.auth?.role ?? null,
      platform: platformRaw ?? null,
      message: err?.message ?? 'Unknown error',
    });
    return res.status(500).json({ error: err?.message ?? 'Failed to save social app config' });
  }
}

// canonical endpoint
router.get('/social-apps/:platform', async (req, res) => {
  return handleGetSocialApp(
    req,
    res,
    String(req.params.platform ?? ''),
    String(req.query?.operator_id ?? ''),
    String(req.query?.scope ?? 'operator')
  );
});

// compatibility alias: /admin/social-apps?platform=linkedin&operator_id=...
router.get('/social-apps', async (req, res) => {
  return handleGetSocialApp(
    req,
    res,
    String(req.query?.platform ?? ''),
    String(req.query?.operator_id ?? ''),
    String(req.query?.scope ?? 'operator')
  );
});

// canonical endpoint
router.put('/social-apps/:platform', async (req, res) => {
  return handlePutSocialApp(req, res, String(req.params.platform ?? ''), req.body, String(req.query?.scope ?? req.body?.scope ?? 'operator'));
});

// compatibility alias: /admin/social-apps with platform in body/query
router.put('/social-apps', async (req, res) => {
  const platform = String(req.body?.platform ?? req.query?.platform ?? '');
  return handlePutSocialApp(req, res, platform, req.body, String(req.query?.scope ?? req.body?.scope ?? 'operator'));
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
