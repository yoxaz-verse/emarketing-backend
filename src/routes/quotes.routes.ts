import { Router } from 'express';
import { requireAuth } from '../middleware/requireAuth';
import { requireWriteRole } from '../middleware/security';
import { createQuoteDraft, listQuotes, updateQuote } from '../services/inquiries/inquiries.service';

const router = Router();
router.use(requireAuth('viewer'));
router.use(requireWriteRole);

router.get('/', async (req, res) => {
  try {
    const data = await listQuotes({
      status: String(req.query?.status ?? '').trim() || null,
      source_code: String(req.query?.source_code ?? '').trim() || null,
      q: String(req.query?.q ?? '').trim() || null,
      owner: String(req.query?.owner ?? '').trim() || null,
      page: Number(req.query?.page ?? 1),
      page_size: Number(req.query?.page_size ?? 25),
    });
    res.json(data);
  } catch (err: any) {
    console.error('[QUOTES_LIST_ERROR]', err?.message ?? err);
    res.status(500).json({ error: err?.message ?? 'Failed to list quotes' });
  }
});

router.post('/', async (req, res) => {
  try {
    const data = await createQuoteDraft({
      inquiry_id: req.body?.inquiry_id,
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
    res.json(data);
  } catch (err: any) {
    console.error('[QUOTES_CREATE_ERROR]', err?.message ?? err);
    res.status(400).json({ error: err?.message ?? 'Failed to create quote' });
  }
});

router.patch('/:id', async (req, res) => {
  try {
    const id = String(req.params.id ?? '').trim();
    if (!id) return res.status(400).json({ error: 'id is required' });

    const data = await updateQuote(id, req.body ?? {}, req.auth?.user_id ?? null);
    return res.json(data);
  } catch (err: any) {
    console.error('[QUOTES_UPDATE_ERROR]', err?.message ?? err);
    return res.status(400).json({ error: err?.message ?? 'Failed to update quote' });
  }
});

export default router;
