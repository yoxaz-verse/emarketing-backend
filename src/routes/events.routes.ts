import { Router } from 'express';
import { requireAuth } from '../middleware/requireAuth';
import { requireWriteRole } from '../middleware/security';
import {
  createEventSource,
  listEvents,
  listEventSources,
  runEventIngestion,
  updateEventStatus,
} from '../services/events.service';

const router = Router();
router.use(requireAuth('viewer'));
router.use(requireWriteRole);

function isSchemaError(err: any): boolean {
  const code = String(err?.code ?? '');
  const message = String(err?.message ?? '').toLowerCase();
  return (
    code === 'PGRST205' ||
    code === '42P01' ||
    code === '42703' ||
    message.includes('schema cache') ||
    message.includes('does not exist') ||
    (message.includes('column') && message.includes('not found')) ||
    message.includes('relation')
  );
}

function statusForError(err: any, fallbackStatus: number): number {
  return isSchemaError(err) ? 500 : fallbackStatus;
}

function stableErrorMessage(err: any, fallbackMessage: string): string {
  if (isSchemaError(err)) return 'Events Intelligence schema is not ready. Apply latest migrations and retry.';
  return err?.message ?? fallbackMessage;
}

router.get('/', async (req, res) => {
  try {
    const data = await listEvents({
      scope: String(req.query.scope ?? ''),
      country: String(req.query.country ?? ''),
      state: String(req.query.state ?? ''),
      district: String(req.query.district ?? ''),
      category: String(req.query.category ?? ''),
      source_id: String(req.query.source_id ?? ''),
      status: String(req.query.status ?? ''),
      days: Number(req.query.days ?? 30),
      page: Number(req.query.page ?? 1),
      page_size: Number(req.query.page_size ?? 50),
    });
    res.json(data);
  } catch (err: any) {
    const status = statusForError(err, 500);
    console.error('[EVENTS_LIST_ERROR]', { status, code: err?.code, message: err?.message ?? err });
    res.status(status).json({ error: stableErrorMessage(err, 'Failed to list events') });
  }
});

router.get('/sources', async (_req, res) => {
  try {
    const data = await listEventSources();
    res.json(data);
  } catch (err: any) {
    const status = statusForError(err, 500);
    console.error('[EVENT_SOURCES_LIST_ERROR]', { status, code: err?.code, message: err?.message ?? err });
    res.status(status).json({ error: stableErrorMessage(err, 'Failed to list event sources') });
  }
});

router.post('/sources', requireAuth('user'), async (req, res) => {
  try {
    const data = await createEventSource(
      {
        source_name: req.body?.source_name,
        provider_type: req.body?.provider_type,
        source_url: req.body?.source_url,
        geography_scope: req.body?.geography_scope,
        country: req.body?.country,
        state: req.body?.state,
        district: req.body?.district,
        categories: req.body?.categories,
        trust_score: req.body?.trust_score,
        polling_interval_minutes: req.body?.polling_interval_minutes,
        active: req.body?.active,
      },
      req.auth?.user_id
    );
    res.json(data);
  } catch (err: any) {
    const status = statusForError(err, 400);
    console.error('[EVENT_SOURCE_CREATE_ERROR]', { status, code: err?.code, message: err?.message ?? err });
    res.status(status).json({ error: stableErrorMessage(err, 'Failed to create event source') });
  }
});

router.post('/ingest/run', requireAuth('user'), async (req, res) => {
  try {
    const data = await runEventIngestion(req.auth?.user_id);
    res.json(data);
  } catch (err: any) {
    const status = statusForError(err, 400);
    console.error('[EVENT_INGEST_RUN_ERROR]', { status, code: err?.code, message: err?.message ?? err });
    res.status(status).json({ error: stableErrorMessage(err, 'Failed to run event ingestion') });
  }
});

router.post('/:id/save', requireAuth('user'), async (req, res) => {
  try {
    const data = await updateEventStatus(
      req.params.id,
      {
        status: 'planned',
        planning_notes: req.body?.planning_notes,
      },
      req.auth?.user_id
    );
    res.json(data);
  } catch (err: any) {
    const status = statusForError(err, 400);
    console.error('[EVENT_SAVE_ERROR]', { status, code: err?.code, message: err?.message ?? err });
    res.status(status).json({ error: stableErrorMessage(err, 'Failed to save event') });
  }
});

router.patch('/:id', requireAuth('user'), async (req, res) => {
  try {
    const data = await updateEventStatus(
      req.params.id,
      {
        status: req.body?.status,
        planning_notes: req.body?.planning_notes,
      },
      req.auth?.user_id
    );
    res.json(data);
  } catch (err: any) {
    const status = statusForError(err, 400);
    console.error('[EVENT_UPDATE_ERROR]', { status, code: err?.code, message: err?.message ?? err });
    res.status(status).json({ error: stableErrorMessage(err, 'Failed to update event') });
  }
});

export default router;
