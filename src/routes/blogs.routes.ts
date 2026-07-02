import { Router } from 'express';
import { requireAuth } from '../middleware/requireAuth';
import { requireWriteRole } from '../middleware/security';
import {
  approveBlog,
  createBlogPlatformPublishJobs,
  createBlog,
  createBlogSource,
  distributeBlog,
  fetchBlogsByContent,
  importBlog,
  importFetchedBlogs,
  listBlogPlatformConnectors,
  listBlogPublishJobs,
  listBlogs,
  listBlogSources,
  listReviewQueue,
  rejectBlog,
  retryBlogPublishJob,
  runRssIngestion,
} from '../services/blogs/blogs.service';

const router = Router();
router.use(requireAuth('viewer'));
router.use(requireWriteRole);

function isSchemaError(err: any): boolean {
  const code = String(err?.code ?? '');
  const message = String(err?.message ?? '').toLowerCase();
  if (code === 'PGRST205' || code === '42P01' || code === '42703') return true;
  return (
    message.includes('does not exist') ||
    message.includes('schema cache') ||
    message.includes('column') && message.includes('not found') ||
    message.includes('relation')
  );
}

function statusForError(err: any, fallbackStatus: number): number {
  return isSchemaError(err) ? 500 : fallbackStatus;
}

function stableErrorMessage(err: any, fallbackMessage: string): string {
  if (isSchemaError(err)) return 'Blog module schema is not ready. Apply latest migrations and retry.';
  return err?.message ?? fallbackMessage;
}

router.get('/', async (req, res) => {
  try {
    const data = await listBlogs(Number(req.query.page ?? 1), Number(req.query.page_size ?? 100));
    res.json(data);
  } catch (err: any) {
    const status = statusForError(err, 500);
    console.error('[BLOGS_LIST_FETCH_REJECT]', { status, code: err?.code, message: err?.message ?? err });
    res.status(status).json({ error: stableErrorMessage(err, 'Failed to list blogs') });
  }
});

router.post('/', async (req, res) => {
  try {
    const data = await createBlog(
      {
        title: req.body?.title,
        body: req.body?.body,
        source_type: req.body?.source_type,
        source_url: req.body?.source_url,
        community_ids: req.body?.community_ids,
      },
      req.auth?.user_id
    );
    res.json(data);
  } catch (err: any) {
    const status = statusForError(err, 400);
    console.error('[BLOG_CREATE_FETCH_REJECT]', { status, code: err?.code, message: err?.message ?? err });
    res.status(status).json({ error: stableErrorMessage(err, 'Failed to create blog') });
  }
});

router.get('/sources', async (_req, res) => {
  try {
    const data = await listBlogSources();
    res.json(data);
  } catch (err: any) {
    const status = statusForError(err, 500);
    console.error('[BLOG_SOURCES_LIST_FETCH_REJECT]', { status, code: err?.code, message: err?.message ?? err });
    res.status(status).json({ error: stableErrorMessage(err, 'Failed to list blog sources') });
  }
});

router.get('/platform-connectors', async (_req, res) => {
  try {
    const data = await listBlogPlatformConnectors();
    res.json(data);
  } catch (err: any) {
    const status = statusForError(err, 500);
    console.error('[BLOG_PLATFORM_CONNECTORS_FETCH_REJECT]', { status, code: err?.code, message: err?.message ?? err });
    res.status(status).json({ error: stableErrorMessage(err, 'Failed to list blog platform connectors') });
  }
});

router.post('/sources', requireAuth('user'), async (req, res) => {
  try {
    const data = await createBlogSource(
      {
        provider_type: req.body?.provider_type,
        publisher_name: req.body?.publisher_name,
        source_name: req.body?.source_name,
        feed_url: req.body?.feed_url,
        region: req.body?.region,
        categories: req.body?.categories,
        trust_score: req.body?.trust_score,
        active: req.body?.active,
        polling_interval_minutes: req.body?.polling_interval_minutes,
      },
      req.auth?.user_id
    );
    res.json(data);
  } catch (err: any) {
    const status = statusForError(err, 400);
    console.error('[BLOG_SOURCE_CREATE_FETCH_REJECT]', { status, code: err?.code, message: err?.message ?? err });
    res.status(status).json({ error: stableErrorMessage(err, 'Failed to create blog source') });
  }
});

router.post('/ingest/run', requireAuth('user'), async (req, res) => {
  try {
    const data = await runRssIngestion(req.auth?.user_id);
    res.json(data);
  } catch (err: any) {
    const status = statusForError(err, 400);
    console.error('[BLOG_INGEST_RUN_FETCH_REJECT]', { status, code: err?.code, message: err?.message ?? err });
    res.status(status).json({ error: stableErrorMessage(err, 'Failed to run ingestion') });
  }
});

router.get('/review-queue', async (_req, res) => {
  try {
    const data = await listReviewQueue();
    res.json(data);
  } catch (err: any) {
    const status = statusForError(err, 500);
    console.error('[BLOG_REVIEW_QUEUE_FETCH_REJECT]', { status, code: err?.code, message: err?.message ?? err });
    res.status(status).json({ error: stableErrorMessage(err, 'Failed to list review queue') });
  }
});

router.post('/import', async (req, res) => {
  try {
    const data = await importBlog(
      {
        source_type: req.body?.source_type,
        source_url: req.body?.source_url,
        community_ids: req.body?.community_ids,
      },
      req.auth?.user_id
    );
    res.json(data);
  } catch (err: any) {
    const status = statusForError(err, 400);
    console.error('[BLOG_IMPORT_FETCH_REJECT]', { status, code: err?.code, message: err?.message ?? err });
    res.status(status).json({ error: stableErrorMessage(err, 'Failed to import blog') });
  }
});

router.post('/fetch', async (req, res) => {
  try {
    const data = await fetchBlogsByContent({
      content_or_keywords: req.body?.content_or_keywords,
      source_ids: req.body?.source_ids,
      publisher: req.body?.publisher,
      category: req.body?.category,
      limit: req.body?.limit,
    });
    res.json(data);
  } catch (err: any) {
    const status = statusForError(err, 400);
    console.error('[BLOG_FETCH_BY_CONTENT_REJECT]', { status, code: err?.code, message: err?.message ?? err });
    res.status(status).json({ error: stableErrorMessage(err, 'Failed to fetch blogs by content') });
  }
});

router.post('/fetch/import', async (req, res) => {
  try {
    const data = await importFetchedBlogs(
      {
        items: req.body?.items,
        community_ids: req.body?.community_ids,
      },
      req.auth?.user_id
    );
    res.json(data);
  } catch (err: any) {
    const status = statusForError(err, 400);
    console.error('[BLOG_FETCH_IMPORT_REJECT]', { status, code: err?.code, message: err?.message ?? err });
    res.status(status).json({ error: stableErrorMessage(err, 'Failed to import fetched blogs') });
  }
});

router.post('/:id/approve', requireAuth('user'), async (req, res) => {
  try {
    const data = await approveBlog(
      req.params.id,
      {
        notes: req.body?.notes,
        community_ids: req.body?.community_ids,
      },
      req.auth?.user_id
    );
    res.json(data);
  } catch (err: any) {
    const status = statusForError(err, 400);
    console.error('[BLOG_APPROVE_FETCH_REJECT]', { status, code: err?.code, message: err?.message ?? err });
    res.status(status).json({ error: stableErrorMessage(err, 'Failed to approve blog') });
  }
});

router.post('/:id/reject', requireAuth('user'), async (req, res) => {
  try {
    const data = await rejectBlog(
      req.params.id,
      {
        notes: req.body?.notes,
      },
      req.auth?.user_id
    );
    res.json(data);
  } catch (err: any) {
    const status = statusForError(err, 400);
    console.error('[BLOG_REJECT_FETCH_REJECT]', { status, code: err?.code, message: err?.message ?? err });
    res.status(status).json({ error: stableErrorMessage(err, 'Failed to reject blog') });
  }
});

router.post('/:id/distribute', async (req, res) => {
  try {
    const data = await distributeBlog(
      req.params.id,
      {
        channels: req.body?.channels,
        scheduled_at: req.body?.scheduled_at,
        timezone: req.body?.timezone,
        cta_url: req.body?.cta_url,
      },
      req.auth?.user_id,
      req.auth?.operator_id
    );
    res.json(data);
  } catch (err: any) {
    const status = statusForError(err, 400);
    console.error('[BLOG_DISTRIBUTION_FETCH_REJECT]', { status, code: err?.code, message: err?.message ?? err });
    res.status(status).json({ error: stableErrorMessage(err, 'Failed to distribute blog') });
  }
});

router.post('/:id/platform-publish-jobs', async (req, res) => {
  try {
    const data = await createBlogPlatformPublishJobs(
      req.params.id,
      {
        targets: req.body?.targets,
        scheduled_at: req.body?.scheduled_at,
        timezone: req.body?.timezone,
        social_channels: req.body?.social_channels,
        cta_url: req.body?.cta_url,
      },
      req.auth?.user_id,
      req.auth?.operator_id
    );
    res.json(data);
  } catch (err: any) {
    const status = statusForError(err, 400);
    console.error('[BLOG_PLATFORM_PUBLISH_CREATE_FETCH_REJECT]', { status, code: err?.code, message: err?.message ?? err });
    res.status(status).json({ error: stableErrorMessage(err, 'Failed to create blog platform publish jobs') });
  }
});

router.get('/:id/publish-jobs', async (req, res) => {
  try {
    const data = await listBlogPublishJobs(req.params.id);
    res.json(data);
  } catch (err: any) {
    const status = statusForError(err, 500);
    console.error('[BLOG_PLATFORM_PUBLISH_LIST_FETCH_REJECT]', { status, code: err?.code, message: err?.message ?? err });
    res.status(status).json({ error: stableErrorMessage(err, 'Failed to list blog publish jobs') });
  }
});

router.post('/publish-jobs/:jobId/retry', async (req, res) => {
  try {
    const data = await retryBlogPublishJob(
      req.params.jobId,
      { notes: req.body?.notes },
      req.auth?.user_id
    );
    res.json(data);
  } catch (err: any) {
    const status = statusForError(err, 400);
    console.error('[BLOG_PLATFORM_PUBLISH_RETRY_FETCH_REJECT]', { status, code: err?.code, message: err?.message ?? err });
    res.status(status).json({ error: stableErrorMessage(err, 'Failed to retry blog publish job') });
  }
});

export default router;
