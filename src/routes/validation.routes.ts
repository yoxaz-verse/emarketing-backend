import { Router } from 'express'
import { runEmailEligibilityValidation } from '../services/validation/lead.email.validation'
import { validateSmtpAccount } from '../services/validation/smtp.validation';
import { inspectSendingDomain } from '../services/validation/domain.validation';
import { supabase } from '../supabase';

const router = Router()

// Campaign Step 2 Email validation (ASYNC / WORKER STYLE)
router.post('/lead', runEmailEligibilityValidation)

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
  
    const result = await inspectSendingDomain(domain);
  
    await supabase
      .from('sending_domains')
      .update({
        spf_verified: result.hasSpf,
        dkim_verified: result.hasDkim,
        dmarc_verified: result.hasDmarc,
        health_score:
          result.hasSpf && result.hasDkim && result.hasDmarc ? 100 : 60,
      })
      .eq('id', domain_id);
  
    return res.json({
      success: true,
      data: result,
    });
  });
  
  
export default router
