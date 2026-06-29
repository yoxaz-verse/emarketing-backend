import { Router } from 'express';
import { requireAuth } from '../middleware/requireAuth';
import { supabase } from '../supabase';
import { insertSystemEvent } from '../services/systemEvents.service';

const router = Router();
router.use(requireAuth('viewer'));

function createHttpError(message: string, statusCode: number) {
  const error = new Error(message) as Error & { statusCode?: number };
  error.statusCode = statusCode;
  return error;
}

function resolveStatusCode(err: any, fallback = 500) {
  const statusCode = Number(err?.statusCode ?? err?.status ?? 0);
  if (Number.isInteger(statusCode) && statusCode >= 400 && statusCode < 600) {
    return statusCode;
  }
  return fallback;
}

function isOperatorScopedRequest(req: any): boolean {
  const role = String(req?.auth?.role ?? '').toLowerCase();
  const isAdmin = role === 'admin' || role === 'superadmin';
  const hasOperatorId = String(req?.auth?.operator_id ?? '').trim().length > 0;
  return !isAdmin && hasOperatorId;
}

router.post('/:id/remove-suppression', requireAuth('admin'), async (req, res) => {
  const leadId = String(req.params.id ?? '').trim();
  if (req.body?.confirm_explicit_consent !== true) {
    return res.status(400).json({ error: 'Explicit re-consent confirmation is required.' });
  }

  try {
    const { data: lead, error: leadError } = await supabase
      .from('leads')
      .select('id,email,email_eligibility,is_suppressed,suppression_reason')
      .eq('id', leadId)
      .maybeSingle();
    if (leadError) throw leadError;
    if (!lead) throw createHttpError('Lead not found', 404);
    if (lead.is_suppressed !== true) {
      return res.json({ success: true, lead_id: leadId, already_unsuppressed: true, requeued_count: 0 });
    }

    const eligibility = String(lead.email_eligibility ?? '').toLowerCase();
    if (eligibility !== 'eligible' && eligibility !== 'risky') {
      throw createHttpError('Validate this email successfully before removing suppression.', 409);
    }

    const previousReason = String(lead.suppression_reason ?? 'suppressed');
    const { data: reconsentRows, error: reconsentError } = await supabase.rpc(
      'remove_lead_suppression_with_reconsent',
      { p_lead_id: leadId }
    );
    if (reconsentError) throw reconsentError;
    const requeuedCount = Number((reconsentRows as any[])?.[0]?.requeued_count ?? 0);

    await insertSystemEvent({
      type: 'lead_suppression_removed',
      entity: 'leads',
      entity_id: leadId,
      message: `Global suppression removed after explicit re-consent for ${String(lead.email ?? leadId)}.`,
      meta: {
        previous_reason: previousReason,
        actor_user_id: req.auth?.user_id ?? null,
        requeued_count: requeuedCount,
      },
    });

    return res.json({
      success: true,
      lead_id: leadId,
      already_unsuppressed: false,
      requeued_count: requeuedCount,
    });
  } catch (err: any) {
    console.error('[LEAD REMOVE SUPPRESSION ERROR]', err);
    return res.status(resolveStatusCode(err, 500)).json({ error: err.message ?? 'Failed to remove suppression' });
  }
});

router.post('/:id/reuse', async (req, res) => {
  const leadId = String(req.params.id ?? '').trim();
  if (!leadId) {
    return res.status(400).json({ error: 'lead id is required' });
  }

  try {
    const operatorScoped = isOperatorScopedRequest(req);
    const operatorId = String(req?.auth?.operator_id ?? '').trim();

    const { data: leadRow, error: leadError } = await supabase
      .from('leads')
      .select('id,operator_id')
      .eq('id', leadId)
      .maybeSingle();
    if (leadError) throw leadError;
    if (!leadRow) throw createHttpError('Lead not found', 404);
    if (operatorScoped && String(leadRow.operator_id ?? '') !== operatorId) {
      throw createHttpError('Lead not found', 404);
    }

    const { data: campaignLeadRows, error: campaignLeadError } = await supabase
      .from('campaign_leads')
      .select('id,campaign_id')
      .eq('lead_id', leadId);
    if (campaignLeadError) throw campaignLeadError;

    const campaignLeadIds = (campaignLeadRows ?? []).map((row: any) => String(row.id)).filter(Boolean);
    const campaignIds = Array.from(new Set((campaignLeadRows ?? []).map((row: any) => String(row.campaign_id)).filter(Boolean)));

    if (campaignLeadIds.length === 0) {
      return res.json({
        success: true,
        lead_id: leadId,
        detached_count: 0,
        blocked_running_count: 0,
        remaining_count: 0,
        reused: true,
      });
    }

    const { data: campaignRows, error: campaignRowsError } = await supabase
      .from('campaigns')
      .select('id,status,operator_id')
      .in('id', campaignIds);
    if (campaignRowsError) throw campaignRowsError;

    const campaignMap = new Map<string, { status?: string | null; operator_id?: string | null }>(
      (campaignRows ?? []).map((row: any) => [
        String(row.id),
        {
          status: row.status ?? null,
          operator_id: row.operator_id ?? null,
        },
      ])
    );

    const toDetachIds: string[] = [];
    const blockedIds: string[] = [];

    for (const row of campaignLeadRows ?? []) {
      const campaign = campaignMap.get(String(row.campaign_id));
      const campaignStatus = String(campaign?.status ?? '').toLowerCase();
      const campaignOperatorId = String(campaign?.operator_id ?? '');

      if (operatorScoped && campaignOperatorId && campaignOperatorId !== operatorId) {
        continue;
      }

      if (campaignStatus === 'running') {
        blockedIds.push(String(row.id));
      } else {
        toDetachIds.push(String(row.id));
      }
    }

    if (toDetachIds.length > 0) {
      const { error: detachError } = await supabase
        .from('campaign_leads')
        .delete()
        .in('id', toDetachIds);
      if (detachError) throw detachError;
    }

    const { count: remainingCount, error: remainingError } = await supabase
      .from('campaign_leads')
      .select('id', { count: 'exact', head: true })
      .eq('lead_id', leadId);
    if (remainingError) throw remainingError;

    const blockedRunningCount = blockedIds.length;
    const detachedCount = toDetachIds.length;
    const safeRemainingCount = Number(remainingCount ?? 0);

    if (blockedRunningCount > 0 && detachedCount === 0) {
      throw createHttpError('Lead is still attached to a running campaign. Pause it first before reuse.', 409);
    }

    return res.json({
      success: true,
      lead_id: leadId,
      detached_count: detachedCount,
      blocked_running_count: blockedRunningCount,
      remaining_count: safeRemainingCount,
      reused: safeRemainingCount === 0,
    });
  } catch (err: any) {
    console.error('[LEAD REUSE ERROR]', err);
    return res.status(resolveStatusCode(err, 500)).json({
      error: err.message ?? 'Failed to reuse lead',
    });
  }
});

export default router;
