import { Router } from 'express';
import { requireAuth } from '../middleware/requireAuth';
import { requireWriteRole } from '../middleware/security';
import {
  createIndustryFetchRun,
  exportIndustryOpportunities,
  getIndustrySummary,
  listIndustryFetchRuns,
  listIndustryOpportunities,
  listIndustrySources,
  updateIndustryOpportunity,
} from '../services/industry-intelligence/industryIntelligence.service';

const router = Router();
router.use(requireAuth('viewer'));
router.use(requireWriteRole);

router.get('/summary', async (_req, res) => {
  try {
    const data = await getIndustrySummary();
    res.json(data);
  } catch (err: any) {
    console.error('[INDUSTRY_INTELLIGENCE_SUMMARY_ERROR]', err?.message ?? err);
    res.status(500).json({ error: err?.message ?? 'Failed to load industry intelligence summary' });
  }
});

router.get('/sources', async (_req, res) => {
  try {
    const data = await listIndustrySources();
    res.json(data);
  } catch (err: any) {
    console.error('[INDUSTRY_INTELLIGENCE_SOURCES_ERROR]', err?.message ?? err);
    res.status(500).json({ error: err?.message ?? 'Failed to list industry intelligence sources' });
  }
});

router.get('/fetch-runs', async (req, res) => {
  try {
    const data = await listIndustryFetchRuns(Number(req.query?.limit ?? 20));
    res.json(data);
  } catch (err: any) {
    console.error('[INDUSTRY_INTELLIGENCE_FETCH_RUNS_ERROR]', err?.message ?? err);
    res.status(500).json({ error: err?.message ?? 'Failed to list industry intelligence fetch runs' });
  }
});

router.post('/fetch-runs', async (req, res) => {
  try {
    const sourceCodes = Array.isArray(req.body?.source_codes)
      ? req.body.source_codes.map((x: unknown) => String(x).trim().toLowerCase()).filter(Boolean)
      : [];
    const sourceCode = String(req.body?.source_code ?? '').trim().toLowerCase();
    const itemsBySource = (req.body?.items_by_source && typeof req.body.items_by_source === 'object')
      ? req.body.items_by_source
      : undefined;
    const items = Array.isArray(req.body?.items) ? req.body.items : [];

    const data = await createIndustryFetchRun({
      sourceCodes: sourceCodes.length > 0 ? sourceCodes : [sourceCode].filter(Boolean),
      triggerMode: sourceCodes.length > 1 ? 'multi_source_fetch' : (items.length > 0 ? 'manual_import' : 'source_fetch'),
      itemsBySource: itemsBySource ?? (sourceCode && items.length > 0 ? { [sourceCode]: items } : undefined),
      userId: req.auth?.user_id ?? null,
      operatorId: req.auth?.operator_id ?? null,
    });

    res.json(data);
  } catch (err: any) {
    console.error('[INDUSTRY_INTELLIGENCE_FETCH_RUN_CREATE_ERROR]', err?.message ?? err);
    res.status(400).json({ error: err?.message ?? 'Failed to create industry intelligence fetch run' });
  }
});

router.get('/opportunities', async (req, res) => {
  try {
    const data = await listIndustryOpportunities({
      source_code: String(req.query?.source_code ?? '').trim() || null,
      category: String(req.query?.category ?? '').trim() || null,
      sector: String(req.query?.sector ?? '').trim() || null,
      funding_stage: String(req.query?.funding_stage ?? '').trim() || null,
      status: String(req.query?.status ?? '').trim() || null,
      from: String(req.query?.from ?? '').trim() || null,
      to: String(req.query?.to ?? '').trim() || null,
      q: String(req.query?.q ?? '').trim() || null,
      page: Number(req.query?.page ?? 1),
      page_size: Number(req.query?.page_size ?? 25),
    });
    res.json(data);
  } catch (err: any) {
    console.error('[INDUSTRY_INTELLIGENCE_OPPORTUNITIES_ERROR]', err?.message ?? err);
    res.status(500).json({ error: err?.message ?? 'Failed to list industry intelligence opportunities' });
  }
});

router.patch('/opportunities/:id', async (req, res) => {
  try {
    const id = String(req.params.id ?? '').trim();
    if (!id) return res.status(400).json({ error: 'id is required' });
    const data = await updateIndustryOpportunity(id, req.body ?? {});
    return res.json(data);
  } catch (err: any) {
    console.error('[INDUSTRY_INTELLIGENCE_OPPORTUNITY_UPDATE_ERROR]', err?.message ?? err);
    return res.status(400).json({ error: err?.message ?? 'Failed to update industry intelligence opportunity' });
  }
});

router.get('/export', async (req, res) => {
  try {
    const formatRaw = String(req.query?.format ?? 'csv').toLowerCase();
    const format = formatRaw === 'xlsx' ? 'xlsx' : 'csv';
    const exported = await exportIndustryOpportunities(
      {
        source_code: String(req.query?.source_code ?? '').trim() || null,
        category: String(req.query?.category ?? '').trim() || null,
        sector: String(req.query?.sector ?? '').trim() || null,
        funding_stage: String(req.query?.funding_stage ?? '').trim() || null,
        status: String(req.query?.status ?? '').trim() || null,
        from: String(req.query?.from ?? '').trim() || null,
        to: String(req.query?.to ?? '').trim() || null,
        q: String(req.query?.q ?? '').trim() || null,
      },
      format
    );

    res.setHeader('Content-Type', exported.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${exported.fileName}"`);
    return res.status(200).send(exported.buffer);
  } catch (err: any) {
    console.error('[INDUSTRY_INTELLIGENCE_EXPORT_ERROR]', err?.message ?? err);
    return res.status(400).json({ error: err?.message ?? 'Failed to export industry intelligence opportunities' });
  }
});

export default router;
