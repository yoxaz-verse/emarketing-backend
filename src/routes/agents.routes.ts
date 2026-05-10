import { Router } from 'express';
import {
  createAgent,
  deleteAgent,
  getAgentByIdSafe,
  listAgents,
  testAgentConnection,
  updateAgent,
} from '../services/agents/agentIntegrations.service';

const router = Router();

router.post('/', async (req, res) => {
  try {
    const data = await createAgent({
      name: req.body.name,
      provider: req.body.provider,
      provider_type: req.body.provider_type,
      base_url: req.body.base_url,
      endpoint: req.body.endpoint,
      auth_type: req.body.auth_type,
      auth_header_name: req.body.auth_header_name,
      auth_secret: req.body.auth_secret,
      headers_config: req.body.headers_config,
      default_model: req.body.default_model,
      default_path: req.body.default_path,
    });

    res.json(data);
  } catch (err: any) {
    console.error('[AGENT CREATE ERROR]', err?.message ?? err);
    res.status(400).json({ error: err.message ?? 'Create failed' });
  }
});

router.get('/', async (_req, res) => {
  try {
    const data = await listAgents();
    res.json(data);
  } catch (err: any) {
    console.error('[AGENT LIST ERROR]', err?.message ?? err);
    res.status(500).json({ error: err.message ?? 'Failed to list agents' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const data = await getAgentByIdSafe(req.params.id);
    res.json(data);
  } catch (err: any) {
    console.error('[AGENT READ ERROR]', err?.message ?? err);
    res.status(404).json({ error: err.message ?? 'Agent not found' });
  }
});

router.patch('/:id', async (req, res) => {
  try {
    const data = await updateAgent(req.params.id, {
      name: req.body.name,
      provider: req.body.provider,
      provider_type: req.body.provider_type,
      base_url: req.body.base_url,
      endpoint: req.body.endpoint,
      auth_type: req.body.auth_type,
      auth_header_name: req.body.auth_header_name,
      auth_secret: req.body.auth_secret,
      headers_config: req.body.headers_config,
      default_model: req.body.default_model,
      default_path: req.body.default_path,
    });

    res.json(data);
  } catch (err: any) {
    console.error('[AGENT UPDATE ERROR]', err?.message ?? err);
    res.status(400).json({ error: err.message ?? 'Update failed' });
  }
});

router.post('/:id/test', async (req, res) => {
  try {
    const result = await testAgentConnection(req.params.id, {
      payload: req.body?.payload,
      model: req.body?.model,
      path: req.body?.path,
    });

    res.json(result);
  } catch (err: any) {
    console.error('[AGENT TEST ERROR]', err?.message ?? err);
    res.status(400).json({
      success: false,
      statusCode: 0,
      latencyMs: 0,
      responsePreview: null,
      error: err.message ?? 'Connection test failed',
    });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    await deleteAgent(req.params.id);
    res.json({ success: true });
  } catch (err: any) {
    console.error('[AGENT DELETE ERROR]', err?.message ?? err);
    res.status(400).json({ error: err.message ?? 'Delete failed' });
  }
});

export default router;
