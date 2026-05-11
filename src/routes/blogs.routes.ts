import { Router } from 'express';
import { requireAuth } from '../middleware/requireAuth';
import { createBlog, distributeBlog, importBlog, listBlogs } from '../services/blogs/blogs.service';

const router = Router();
router.use(requireAuth('viewer'));

router.get('/', async (_req, res) => {
  try {
    const data = await listBlogs();
    res.json(data);
  } catch (err: any) {
    console.error('[BLOGS LIST ERROR]', err?.message ?? err);
    res.status(500).json({ error: err?.message ?? 'Failed to list blogs' });
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
      },
      req.auth?.user_id
    );
    res.json(data);
  } catch (err: any) {
    console.error('[BLOG CREATE ERROR]', err?.message ?? err);
    res.status(400).json({ error: err?.message ?? 'Failed to create blog' });
  }
});

router.post('/import', async (req, res) => {
  try {
    const data = await importBlog(
      {
        source_type: req.body?.source_type,
        source_url: req.body?.source_url,
      },
      req.auth?.user_id
    );
    res.json(data);
  } catch (err: any) {
    console.error('[BLOG IMPORT ERROR]', err?.message ?? err);
    res.status(400).json({ error: err?.message ?? 'Failed to import blog' });
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
    console.error('[BLOG DISTRIBUTION ERROR]', err?.message ?? err);
    res.status(400).json({ error: err?.message ?? 'Failed to distribute blog' });
  }
});

export default router;
