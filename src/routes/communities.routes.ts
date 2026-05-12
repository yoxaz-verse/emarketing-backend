import { Router } from 'express';
import { requireAuth } from '../middleware/requireAuth';
import { listCommunityBlogFeed } from '../services/blogs/blogs.service';

const router = Router();
router.use(requireAuth('viewer'));

router.get('/:communityId/blog-feed', async (req, res) => {
  try {
    const communityId = String(req.params.communityId ?? '').trim();
    if (!communityId) {
      return res.status(400).json({ error: 'communityId is required' });
    }
    const limit = Number(req.query?.limit ?? 25);
    const data = await listCommunityBlogFeed(communityId, limit);
    return res.json(data);
  } catch (err: any) {
    console.error('[COMMUNITY BLOG FEED ERROR]', err?.message ?? err);
    return res.status(400).json({ error: err?.message ?? 'Failed to list community blog feed' });
  }
});

export default router;
