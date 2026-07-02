import { Router } from 'express';
import crypto from 'crypto';
import { requireAuth } from '../middleware/requireAuth';
import { requireWriteRole } from '../middleware/security';
import {
  createAgent,
  deleteAgent,
  getAgentByIdSafe,
  listAgents,
  testAgentConnection,
  updateAgent,
} from '../services/agents/agentIntegrations.service';
import {
  chatWithAgentRole,
  getRoleMemory,
  resetRoleMemory,
} from '../services/agents/openclawChat.service';
import {
  createAgentContextDocument,
  createAgentTask,
  getAgentTaskById,
  listAgentContextDocuments,
  listAgentTasks,
  pickNextAgentTask,
  submitAgentTaskResult,
} from '../services/agents/agentTasks.service';
import {
  bootstrapEmployeeTeam,
  createMission,
  getAgentRuntimeOverview,
  getMissionTemplates,
  listMissionRuns,
  listMissions,
  runMissionNow,
  updateMission,
} from '../services/agents/agentMissions.service';

const router = Router();
const WORKER_SECRET = String(process.env.OPENCLAW_WORKER_SECRET ?? '').trim();

function isWorkerAuthorized(authorization?: string) {
  if (!WORKER_SECRET) return false;
  if (!authorization || !authorization.startsWith('Bearer ')) return false;
  const token = authorization.slice(7).trim();
  const expected = Buffer.from(WORKER_SECRET);
  const provided = Buffer.from(token);
  return token.length > 0 && expected.length === provided.length && crypto.timingSafeEqual(expected, provided);
}

router.use((req, res, next) => {
  const workerRoute = req.method === 'GET' && req.path === '/tasks/next'
    || req.method === 'POST' && /^\/tasks\/[^/]+\/result$/.test(req.path);
  if (workerRoute) return next();
  return requireAuth('viewer')(req, res, next);
});
router.use((req, res, next) => {
  const workerRoute = req.method === 'GET' && req.path === '/tasks/next'
    || req.method === 'POST' && /^\/tasks\/[^/]+\/result$/.test(req.path);
  return workerRoute ? next() : requireWriteRole(req, res, next);
});

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
      role_key: req.body.role_key,
      memory_policy: req.body.memory_policy,
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

router.post('/chat', async (req, res) => {
  try {
    const result = await chatWithAgentRole({
      user_id: req.body?.user_id,
      role_key: req.body?.role_key,
      message: req.body?.message,
      context: req.body?.context,
      request_id: req.body?.request_id,
    });
    res.json(result);
  } catch (err: any) {
    console.error('[AGENT CHAT ERROR]', err?.message ?? err);
    res.status(400).json({ error: err.message ?? 'Chat failed' });
  }
});

router.get('/memory', async (req, res) => {
  try {
    const userId = String(req.query.user_id ?? '');
    const roleKey = String(req.query.role_key ?? '');
    const data = await getRoleMemory(userId, roleKey);
    res.json(data);
  } catch (err: any) {
    console.error('[AGENT MEMORY READ ERROR]', err?.message ?? err);
    res.status(400).json({ error: err.message ?? 'Memory read failed' });
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

router.delete('/memory', async (req, res) => {
  try {
    const userId = String(req.query.user_id ?? req.body?.user_id ?? '');
    const roleKey = String(req.query.role_key ?? req.body?.role_key ?? '');
    const data = await resetRoleMemory(userId, roleKey);
    res.json(data);
  } catch (err: any) {
    console.error('[AGENT MEMORY RESET ERROR]', err?.message ?? err);
    res.status(400).json({ error: err.message ?? 'Memory reset failed' });
  }
});

router.post('/tasks', requireAuth('viewer'), async (req, res) => {
  try {
    const data = await createAgentTask(
      {
        role_key: req.body?.role_key,
        task_type: req.body?.task_type,
        input: req.body?.input,
        priority: req.body?.priority,
        metadata: req.body?.metadata,
        source_entity: req.body?.source_entity,
        source_entity_id: req.body?.source_entity_id,
      },
      {
        userId: req.auth?.user_id,
        operatorId: req.auth?.operator_id,
      }
    );
    res.json({
      ok: true,
      task: {
        id: data.id,
        status: data.status,
      },
    });
  } catch (err: any) {
    console.error('[AGENT TASK CREATE ERROR]', err?.message ?? err);
    res.status(400).json({ ok: false, error: err.message ?? 'Create task failed' });
  }
});

router.get('/tasks', requireAuth('viewer'), async (req, res) => {
  try {
    const data = await listAgentTasks({
      status: req.query?.status ? String(req.query.status) : undefined,
      role_key: req.query?.role_key ? String(req.query.role_key) : undefined,
      task_type: req.query?.task_type ? String(req.query.task_type) : undefined,
      limit: req.query?.limit ? Number(req.query.limit) : undefined,
      offset: req.query?.offset ? Number(req.query.offset) : undefined,
    });
    res.json({ ok: true, tasks: data });
  } catch (err: any) {
    console.error('[AGENT TASK LIST ERROR]', err?.message ?? err);
    res.status(400).json({ ok: false, error: err.message ?? 'List tasks failed' });
  }
});

router.get('/tasks/next', async (req, res) => {
  try {
    if (!isWorkerAuthorized(String(req.headers.authorization ?? ''))) {
      return res.status(401).json({ ok: false, error: 'Unauthorized worker' });
    }
    const task = await pickNextAgentTask();
    return res.json({ ok: true, task: task ?? null });
  } catch (err: any) {
    console.error('[AGENT TASK NEXT ERROR]', err?.message ?? err);
    return res.status(500).json({ ok: false, error: err.message ?? 'Failed to pick task' });
  }
});

router.post('/tasks/:id/result', async (req, res) => {
  try {
    if (!isWorkerAuthorized(String(req.headers.authorization ?? ''))) {
      return res.status(401).json({ ok: false, error: 'Unauthorized worker' });
    }
    const status = String(req.body?.status ?? '');
    if (!['completed', 'failed'].includes(status)) {
      return res.status(400).json({ ok: false, error: 'Result status must be completed or failed' });
    }
    if (String(req.body?.result ?? '').length > 1_000_000) {
      return res.status(413).json({ ok: false, error: 'Task result is too large' });
    }
    const data = await submitAgentTaskResult(req.params.id, {
      status,
      result: req.body?.result,
      structured_outputs: req.body?.structured_outputs,
      error: req.body?.error,
    });
    return res.json({ ok: true, task: { id: data.id, status: data.status } });
  } catch (err: any) {
    console.error('[AGENT TASK RESULT ERROR]', err?.message ?? err);
    return res.status(400).json({ ok: false, error: err.message ?? 'Submit result failed' });
  }
});

router.get('/tasks/:id', requireAuth('viewer'), async (req, res) => {
  try {
    const data = await getAgentTaskById(req.params.id);
    res.json({ ok: true, task: data });
  } catch (err: any) {
    console.error('[AGENT TASK READ ERROR]', err?.message ?? err);
    res.status(404).json({ ok: false, error: err.message ?? 'Task not found' });
  }
});

router.get('/runtime', requireAuth('viewer'), async (_req, res) => {
  try {
    const data = await getAgentRuntimeOverview();
    res.json({ ok: true, agents: data });
  } catch (err: any) {
    console.error('[AGENT RUNTIME ERROR]', err?.message ?? err);
    res.status(500).json({ ok: false, error: err.message ?? 'Runtime overview failed' });
  }
});

router.get('/mission-templates', requireAuth('viewer'), async (_req, res) => {
  try {
    res.json({ ok: true, templates: getMissionTemplates() });
  } catch (err: any) {
    console.error('[MISSION TEMPLATE LIST ERROR]', err?.message ?? err);
    res.status(500).json({ ok: false, error: err.message ?? 'Template list failed' });
  }
});

router.post('/bootstrap-employee-team', requireAuth('viewer'), async (req, res) => {
  try {
    const data = await bootstrapEmployeeTeam({
      userId: req.auth?.user_id,
      operatorId: req.auth?.operator_id,
    });
    res.json({ ok: true, ...data });
  } catch (err: any) {
    console.error('[BOOTSTRAP_EMPLOYEE_TEAM_ERROR]', err?.message ?? err);
    res.status(400).json({ ok: false, error: err.message ?? 'Bootstrap employee team failed' });
  }
});

router.get('/missions', requireAuth('viewer'), async (req, res) => {
  try {
    const agentId = req.query?.agent_id ? String(req.query.agent_id) : undefined;
    const data = await listMissions(agentId);
    res.json({ ok: true, missions: data });
  } catch (err: any) {
    console.error('[MISSION LIST ERROR]', err?.message ?? err);
    res.status(400).json({ ok: false, error: err.message ?? 'Mission list failed' });
  }
});

router.post('/missions', requireAuth('viewer'), async (req, res) => {
  try {
    const data = await createMission(
      {
        agent_id: req.body?.agent_id,
        name: req.body?.name,
        role_key: req.body?.role_key,
        task_type: req.body?.task_type,
        mission_goal: req.body?.mission_goal,
        instructions: req.body?.instructions,
        cadence_type: req.body?.cadence_type,
        cadence_value: req.body?.cadence_value,
        timezone: req.body?.timezone,
        next_run_at: req.body?.next_run_at,
        active: req.body?.active,
        execution_policy: req.body?.execution_policy,
        output_policy: req.body?.output_policy,
        priority: req.body?.priority,
        metadata: req.body?.metadata,
      },
      { userId: req.auth?.user_id, operatorId: req.auth?.operator_id }
    );
    res.json({ ok: true, mission: data });
  } catch (err: any) {
    console.error('[MISSION CREATE ERROR]', err?.message ?? err);
    res.status(400).json({ ok: false, error: err.message ?? 'Create mission failed' });
  }
});

router.patch('/missions/:id', requireAuth('viewer'), async (req, res) => {
  try {
    const data = await updateMission(req.params.id, {
      name: req.body?.name,
      mission_goal: req.body?.mission_goal,
      instructions: req.body?.instructions,
      cadence_type: req.body?.cadence_type,
      cadence_value: req.body?.cadence_value,
      timezone: req.body?.timezone,
      next_run_at: req.body?.next_run_at,
      active: req.body?.active,
      execution_policy: req.body?.execution_policy,
      output_policy: req.body?.output_policy,
      priority: req.body?.priority,
      metadata: req.body?.metadata,
      last_status: req.body?.last_status,
    });
    res.json({ ok: true, mission: data });
  } catch (err: any) {
    console.error('[MISSION UPDATE ERROR]', err?.message ?? err);
    res.status(400).json({ ok: false, error: err.message ?? 'Update mission failed' });
  }
});

router.post('/missions/:id/run-now', requireAuth('viewer'), async (req, res) => {
  try {
    const data = await runMissionNow(req.params.id, {
      userId: req.auth?.user_id,
      operatorId: req.auth?.operator_id,
    });
    res.json({ ok: true, ...data });
  } catch (err: any) {
    console.error('[MISSION RUN NOW ERROR]', err?.message ?? err);
    res.status(400).json({ ok: false, error: err.message ?? 'Run now failed' });
  }
});

router.post('/missions/:id/pause', requireAuth('viewer'), async (req, res) => {
  try {
    const data = await updateMission(req.params.id, { active: false, last_status: 'skipped' });
    res.json({ ok: true, mission: data });
  } catch (err: any) {
    console.error('[MISSION PAUSE ERROR]', err?.message ?? err);
    res.status(400).json({ ok: false, error: err.message ?? 'Pause mission failed' });
  }
});

router.post('/missions/:id/resume', requireAuth('viewer'), async (req, res) => {
  try {
    const data = await updateMission(req.params.id, {
      active: true,
      next_run_at: req.body?.next_run_at ?? new Date(Date.now() + 60000).toISOString(),
      last_status: 'queued',
    });
    res.json({ ok: true, mission: data });
  } catch (err: any) {
    console.error('[MISSION RESUME ERROR]', err?.message ?? err);
    res.status(400).json({ ok: false, error: err.message ?? 'Resume mission failed' });
  }
});

router.get('/missions/:id/runs', requireAuth('viewer'), async (req, res) => {
  try {
    const limit = req.query?.limit ? Number(req.query.limit) : 20;
    const runs = await listMissionRuns(req.params.id, limit);
    res.json({ ok: true, runs });
  } catch (err: any) {
    console.error('[MISSION RUN LIST ERROR]', err?.message ?? err);
    res.status(400).json({ ok: false, error: err.message ?? 'List mission runs failed' });
  }
});

router.post('/context-documents', requireAuth('viewer'), async (req, res) => {
  try {
    const data = await createAgentContextDocument(
      {
        name: req.body?.name,
        role_key: req.body?.role_key,
        content: req.body?.content,
        active: req.body?.active,
        metadata: req.body?.metadata,
      },
      {
        userId: req.auth?.user_id,
        operatorId: req.auth?.operator_id,
      }
    );
    res.json({ ok: true, document: data });
  } catch (err: any) {
    console.error('[AGENT CONTEXT CREATE ERROR]', err?.message ?? err);
    res.status(400).json({ ok: false, error: err.message ?? 'Create context document failed' });
  }
});

router.get('/context-documents', requireAuth('viewer'), async (req, res) => {
  try {
    const activeOnly = String(req.query?.active_only ?? 'true') !== 'false';
    const data = await listAgentContextDocuments(activeOnly);
    res.json({ ok: true, documents: data });
  } catch (err: any) {
    console.error('[AGENT CONTEXT LIST ERROR]', err?.message ?? err);
    res.status(500).json({ ok: false, error: err.message ?? 'List context documents failed' });
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
      role_key: req.body.role_key,
      memory_policy: req.body.memory_policy,
    });

    res.json(data);
  } catch (err: any) {
    console.error('[AGENT UPDATE ERROR]', err?.message ?? err);
    res.status(400).json({ error: err.message ?? 'Update failed' });
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
