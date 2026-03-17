import { Router } from 'express';
import { supabase } from '../supabase';
import {
  createSequenceRuns,
  validateSequenceGraph,
} from '../services/sequenceEngine';

const router = Router();

router.get('/', async (_req, res) => {
  try {
    const { data, error } = await supabase
      .from('sequences')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json(data ?? []);
  } catch (err: any) {
    console.error('[SEQUENCES LIST ERROR]', err);
    res.status(500).json({ error: err.message ?? 'Failed to list sequences' });
  }
});

router.post('/', async (req, res) => {
  try {
    const payload = {
      name: req.body.name ?? 'Untitled Sequence',
      graph_json: req.body.graph_json ?? { nodes: [], edges: [] },
      status: req.body.status ?? 'draft',
    };

    const { data, error } = await supabase
      .from('sequences')
      .insert(payload)
      .select('*')
      .single();

    if (error) throw error;
    res.json(data);
  } catch (err: any) {
    console.error('[SEQUENCE CREATE ERROR]', err);
    res.status(400).json({ error: err.message ?? 'Create failed' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('sequences')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (error) throw error;
    res.json(data);
  } catch (err: any) {
    console.error('[SEQUENCE READ ERROR]', err);
    res.status(404).json({ error: err.message ?? 'Sequence not found' });
  }
});

router.patch('/:id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('sequences')
      .update({
        ...req.body,
        updated_at: new Date().toISOString(),
      })
      .eq('id', req.params.id)
      .select('*')
      .single();

    if (error) throw error;
    res.json(data);
  } catch (err: any) {
    console.error('[SEQUENCE UPDATE ERROR]', err);
    res.status(400).json({ error: err.message ?? 'Update failed' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const { error } = await supabase
      .from('sequences')
      .delete()
      .eq('id', req.params.id);

    if (error) throw error;
    res.json({ success: true });
  } catch (err: any) {
    console.error('[SEQUENCE DELETE ERROR]', err);
    res.status(400).json({ error: err.message ?? 'Delete failed' });
  }
});

router.post('/:id/validate', async (req, res) => {
  try {
    const { data: sequence, error } = await supabase
      .from('sequences')
      .select('graph_json')
      .eq('id', req.params.id)
      .single();

    if (error || !sequence) {
      throw error ?? new Error('Sequence not found');
    }

    const graph =
      typeof sequence.graph_json === 'string'
        ? JSON.parse(sequence.graph_json)
        : sequence.graph_json;

    const result = validateSequenceGraph(graph);

    await supabase
      .from('sequences')
      .update({
        status: result.valid ? 'valid' : 'invalid',
        updated_at: new Date().toISOString(),
      })
      .eq('id', req.params.id);

    res.json(result);
  } catch (err: any) {
    console.error('[SEQUENCE VALIDATE ERROR]', err);
    res.status(400).json({ error: err.message ?? 'Validation failed' });
  }
});

router.post('/:id/execute', async (req, res) => {
  try {
    const { data: sequence, error } = await supabase
      .from('sequences')
      .select('graph_json')
      .eq('id', req.params.id)
      .single();

    if (error || !sequence) {
      throw error ?? new Error('Sequence not found');
    }

    const contacts = Array.isArray(req.body.contacts) ? req.body.contacts : null;
    const context = req.body.context ?? {};

    const graph =
      typeof sequence.graph_json === 'string'
        ? JSON.parse(sequence.graph_json)
        : sequence.graph_json;

    const runs = await createSequenceRuns(req.params.id, graph, contacts, context);

    res.json({ success: true, runs });
  } catch (err: any) {
    console.error('[SEQUENCE EXECUTE ERROR]', err);
    res.status(400).json({ error: err.message ?? 'Execution failed' });
  }
});

export default router;
