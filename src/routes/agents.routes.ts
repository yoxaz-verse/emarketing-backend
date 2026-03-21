import { Router } from 'express';
import { supabase } from '../supabase';

const router = Router();

router.post('/', async (req, res) => {
  try {
    const payload = {
      name: req.body.name,
      provider: req.body.provider ?? 'openflow',
      endpoint: req.body.endpoint,
      headers_config: req.body.headers_config ?? {},
    };

    const { data, error } = await supabase
      .from('agents')
      .insert(payload)
      .select('*')
      .single();

    if (error) throw error;
    res.json(data);
  } catch (err: any) {
    console.error('[AGENT CREATE ERROR]', err);
    res.status(400).json({ error: err.message ?? 'Create failed' });
  }
});

router.get('/', async (_req, res) => {
  try {
    const { data, error } = await supabase
      .from('agents')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) {
      // If table doesn't exist, return empty array instead of failing
      if (error.message?.includes('Could not find the table') || error.code === 'PGRST205') {
        console.warn('[AGENT LIST WARNING] agents table missing. Return [].');
        return res.json([]);
      }
      throw error;
    }
    res.json(data ?? []);
  } catch (err: any) {
    console.error('[AGENT LIST ERROR]', err);
    res.status(500).json({ error: err.message ?? 'Failed to list agents' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('agents')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (error) throw error;
    res.json(data);
  } catch (err: any) {
    console.error('[AGENT READ ERROR]', err);
    res.status(404).json({ error: err.message ?? 'Agent not found' });
  }
});

router.patch('/:id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('agents')
      .update(req.body)
      .eq('id', req.params.id)
      .select('*')
      .single();

    if (error) throw error;
    res.json(data);
  } catch (err: any) {
    console.error('[AGENT UPDATE ERROR]', err);
    res.status(400).json({ error: err.message ?? 'Update failed' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const { error } = await supabase
      .from('agents')
      .delete()
      .eq('id', req.params.id);

    if (error) throw error;
    res.json({ success: true });
  } catch (err: any) {
    console.error('[AGENT DELETE ERROR]', err);
    res.status(400).json({ error: err.message ?? 'Delete failed' });
  }
});

export default router;
