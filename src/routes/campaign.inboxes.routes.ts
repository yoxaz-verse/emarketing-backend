import { Router } from 'express';
import { supabase } from '../supabase';
import { requireAuth } from '../middleware/requireAuth';

const router = Router();

/**
 * Detach inbox from campaign
 */
router.delete('/', async (req, res) => {
  try {
    const { campaign_id, inbox_id } = req.query;

    if (!campaign_id || !inbox_id) {
      return res.status(400).json({
        error: 'campaign_id and inbox_id are required'
      });
    }

    const { error } = await supabase
      .from('campaign_inboxes')
      .delete()
      .eq('campaign_id', campaign_id)
      .eq('inbox_id', inbox_id);

    if (error) throw error;

    res.json({ success: true });
  } catch (err: any) {
    console.error('[CAMPAIGN_INBOX DELETE ERROR]', err);
    res.status(400).json({ error: err.message });
  }
});

export default router;
