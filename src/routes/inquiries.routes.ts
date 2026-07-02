import { Router } from 'express';
import { requireAuth } from '../middleware/requireAuth';
import {
  createQuoteDraft,
  createFetchRun,
  createMultiSourceFetchRun,
  exportInquiries,
  listConnectorRuns,
  listFetchRuns,
  listInquiries,
  listInquirySources,
  updateInquiryCoding,
} from '../services/inquiries/inquiries.service';

const router = Router();
import { rateLimit, requireWebhookSignature, requireWriteRole } from '../middleware/security';

router.get('/webhook/:sourceCode', async (req, res) => {
  const sourceCode = String(req.params.sourceCode ?? '').trim().toLowerCase();
  if (!sourceCode) return res.status(400).json({ error: 'sourceCode is required' });

  const challenge = String(req.query?.challenge ?? 'ok');
  return res.status(200).json({ ok: true, source_code: sourceCode, challenge });
});

router.post('/webhook/:sourceCode', rateLimit({ name: 'inquiry-webhook', windowMs: 60_000, max: 60 }), requireWebhookSignature('INQUIRY_WEBHOOK_SECRET'), async (req, res) => {
  try {
    const sourceCode = String(req.params.sourceCode ?? '').trim().toLowerCase();
    if (!sourceCode) return res.status(400).json({ error: 'sourceCode is required' });

    const payload = req.body;
    const items = Array.isArray(payload?.items)
      ? payload.items
      : Array.isArray(payload)
        ? payload
        : [payload];

    const data = await createFetchRun({
      sourceCode,
      triggerMode: 'webhook',
      items,
      userId: null,
      operatorId: null,
    });

    return res.json(data);
  } catch (err: any) {
    console.error('[INQUIRIES_WEBHOOK_ERROR]', err?.message ?? err);
    return res.status(400).json({ error: err?.message ?? 'Failed to ingest webhook inquiries' });
  }
});

router.use(requireAuth('viewer'));
router.use(requireWriteRole);

router.get('/sources', async (_req, res) => {
  try {
    const data = await listInquirySources();
    res.json(data);
  } catch (err: any) {
    console.error('[INQUIRIES_SOURCES_ERROR]', err?.message ?? err);
    res.status(500).json({ error: err?.message ?? 'Failed to list inquiry sources' });
  }
});

router.get('/fetch-runs', async (req, res) => {
  try {
    const limit = Number(req.query?.limit ?? 20);
    const data = await listFetchRuns(limit);
    res.json(data);
  } catch (err: any) {
    console.error('[INQUIRIES_FETCH_RUNS_ERROR]', err?.message ?? err);
    res.status(500).json({ error: err?.message ?? 'Failed to list inquiry fetch runs' });
  }
});

router.get('/connector-runs', async (req, res) => {
  try {
    const limit = Number(req.query?.limit ?? 100);
    const fetchRunId = String(req.query?.fetch_run_id ?? '').trim() || null;
    const data = await listConnectorRuns(fetchRunId, limit);
    res.json(data);
  } catch (err: any) {
    console.error('[INQUIRIES_CONNECTOR_RUNS_ERROR]', err?.message ?? err);
    res.status(500).json({ error: err?.message ?? 'Failed to list inquiry connector runs' });
  }
});

router.post('/fetch-runs', async (req, res) => {
  try {
    const sourceCode = String(req.body?.source_code ?? '').trim().toLowerCase();
    const sourceCodes = Array.isArray(req.body?.source_codes)
      ? req.body.source_codes.map((x: unknown) => String(x).trim().toLowerCase()).filter(Boolean)
      : [];

    if (sourceCodes.length > 0) {
      const data = await createMultiSourceFetchRun({
        sourceCodes,
        triggerMode: 'multi_source_fetch',
        itemsBySource: (req.body?.items_by_source && typeof req.body.items_by_source === 'object') ? req.body.items_by_source : undefined,
        userId: req.auth?.user_id ?? null,
        operatorId: req.auth?.operator_id ?? null,
      });
      return res.json(data);
    }

    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!sourceCode) return res.status(400).json({ error: 'source_code is required when source_codes is not provided' });
    if (items.length === 0) return res.status(400).json({ error: 'items array is required for single-source manual import' });

    const data = await createFetchRun({
      sourceCode,
      triggerMode: 'manual_import',
      items,
      userId: req.auth?.user_id ?? null,
      operatorId: req.auth?.operator_id ?? null,
    });

    return res.json(data);
  } catch (err: any) {
    console.error('[INQUIRIES_CREATE_FETCH_RUN_ERROR]', err?.message ?? err);
    return res.status(400).json({ error: err?.message ?? 'Failed to create fetch run' });
  }
});

router.get('/', async (req, res) => {
  try {
    const data = await listInquiries({
      source_code: String(req.query?.source_code ?? '').trim() || null,
      stage: String(req.query?.stage ?? '').trim() || null,
      coded: String(req.query?.coded ?? '').trim() || null,
      from: String(req.query?.from ?? '').trim() || null,
      to: String(req.query?.to ?? '').trim() || null,
      q: String(req.query?.q ?? '').trim() || null,
      page: Number(req.query?.page ?? 1),
      page_size: Number(req.query?.page_size ?? 25),
    });

    res.json(data);
  } catch (err: any) {
    console.error('[INQUIRIES_LIST_ERROR]', err?.message ?? err);
    res.status(500).json({ error: err?.message ?? 'Failed to list inquiries' });
  }
});

router.patch('/:id/coding', async (req, res) => {
  try {
    const id = String(req.params.id ?? '').trim();
    if (!id) return res.status(400).json({ error: 'id is required' });

    const data = await updateInquiryCoding(id, req.body ?? {}, req.auth?.user_id ?? null);
    return res.json(data);
  } catch (err: any) {
    console.error('[INQUIRIES_CODING_UPDATE_ERROR]', err?.message ?? err);
    return res.status(400).json({ error: err?.message ?? 'Failed to update inquiry coding' });
  }
});

router.post('/:id/quotes', async (req, res) => {
  try {
    const inquiryId = String(req.params.id ?? '').trim();
    if (!inquiryId) return res.status(400).json({ error: 'id is required' });

    const data = await createQuoteDraft({
      inquiry_id: inquiryId,
      price: req.body?.price,
      quantity: req.body?.quantity,
      currency: req.body?.currency,
      incoterm: req.body?.incoterm,
      validity_date: req.body?.validity_date,
      terms: req.body?.terms,
      owner: req.body?.owner,
      notes: req.body?.notes,
      createdBy: req.auth?.user_id ?? null,
    });

    return res.json(data);
  } catch (err: any) {
    console.error('[INQUIRY_QUOTE_CREATE_ERROR]', err?.message ?? err);
    return res.status(400).json({ error: err?.message ?? 'Failed to create quote draft' });
  }
});

router.get('/export', async (req, res) => {
  try {
    const formatRaw = String(req.query?.format ?? 'csv').toLowerCase();
    const format = formatRaw === 'xlsx' ? 'xlsx' : 'csv';

    const exported = await exportInquiries(
      {
        source_code: String(req.query?.source_code ?? '').trim() || null,
        stage: String(req.query?.stage ?? '').trim() || null,
        coded: String(req.query?.coded ?? '').trim() || null,
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
    console.error('[INQUIRIES_EXPORT_ERROR]', err?.message ?? err);
    return res.status(400).json({ error: err?.message ?? 'Failed to export inquiries' });
  }
});

export default router;
