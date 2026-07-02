import { Router } from 'express'
import {
  forceUnlockAndRerunValidation,
  getEmailValidationRunHistory,
  getEmailValidationRunStatus,
  resetStuckAndRerunValidation,
  runEmailEligibilityValidation,
} from '../services/validation/lead.email.validation'
import { validateSmtpAccount } from '../services/validation/smtp.validation';
import { inspectSendingDomain } from '../services/validation/domain.validation';
import { supabase } from '../supabase';
import { requireAuth } from '../middleware/requireAuth';
import { requireWriteRole } from '../middleware/security';

const router = Router()
router.use(requireAuth('viewer'));
router.use(requireWriteRole);

// Campaign Step 2 Email validation (ASYNC / WORKER STYLE)
router.post('/lead', runEmailEligibilityValidation)
router.post('/lead/start', runEmailEligibilityValidation)
router.post('/lead/reset-stuck-rerun', resetStuckAndRerunValidation)
router.post('/lead/force-unlock-rerun', forceUnlockAndRerunValidation)
router.get('/lead/status', getEmailValidationRunStatus)
router.get('/lead/history', getEmailValidationRunHistory)

// Explicit SMTP validation (user clicks "Test SMTP")
router.post('/smtp-accounts/:id', async (req, res) => {
    try {
      const { id } = req.params;
  
      await validateSmtpAccount(id);
  
      res.json({ success: true });
    } catch (err: any) {
      console.error('[SMTP VALIDATION ERROR]', err);
      res.status(400).json({
        success: false,
        error: err.message || 'SMTP validation failed',
      });
    }
  });

  router.post('/domains', async (req, res) => {
    const { domain, domain_id } = req.body;
  
    if (!domain || !domain_id) {
      return res.status(400).json({
        success: false,
        error: 'domain and domain_id are required',
      });
    }
  
    const { data: domainRow, error: domainRowError } = await supabase
      .from('sending_domains')
      .select('dkim_selector')
      .eq('id', domain_id)
      .single();

    if (domainRowError) {
      console.warn('[DOMAIN VALIDATION] dkim_selector lookup failed, falling back to auto-detect only', domainRowError.message);
    }

    const result = await inspectSendingDomain(
      domain,
      domainRowError ? null : domainRow?.dkim_selector ?? null
    );

    const healthScore =
      (result.hasSpf ? 33 : 0) +
      (result.hasDkim ? 33 : 0) +
      (result.hasDmarc ? 34 : 0);

    await supabase
      .from('sending_domains')
      .update({
        spf_verified: result.hasSpf,
        dkim_verified: result.hasDkim,
        dmarc_verified: result.hasDmarc,
        health_score: healthScore,
      })
      .eq('id', domain_id);
  
    return res.json({
      success: true,
      data: result,
    });
  });
  
  
export default router
