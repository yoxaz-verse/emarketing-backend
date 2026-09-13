import crypto from 'crypto';
import { Router, type Request, type Response } from 'express';
import { supabase } from '../supabase';
import { attachLeadsToCampaign, startCampaign, pauseCampaign } from '../services/campaign.domain';
import { authenticateApi, apiError, badRequest, dto, fail, pageInput, requestId, requireScope } from '../publicApi/common';
import { OPENAPI } from '../publicApi/openapi';
import { handleLeadsBeforeWrite } from '../services/domain/leadLifeCycle';
import { handleCampaignBeforeWrite } from '../services/domain/campaignLifeCycle';

const router = Router();
router.use(requestId);
router.get('/openapi.json', (_req, res) => { res.setHeader('Cache-Control', 'public, max-age=300'); res.json(OPENAPI); });
router.use(authenticateApi);

const run = (handler: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response) => { Promise.resolve(handler(req, res)).catch((error) => fail(res, error)); };
const tenant = (req: Request) => req.publicApi!.operatorId;
const uuid = (value: string) => { if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) badRequest('A valid UUID is required.'); return value; };
const db = (result: any) => { if (result.error) throw result.error; return result.data; };
const requireFound = (data: any) => { if (!data) throw Object.assign(new Error('Resource not found.'), { status: 404, code: 'NOT_FOUND' }); return data; };
const leadFields = 'id,email,first_name,last_name,company,country,job_title,phone,linkedin_url,website,industry,source,notes,lead_status,created_at';
const campaignFields = 'id,name,sequence_id,status,sender_display_name,created_at';
const sequenceFields = 'id,name,is_active,created_at';
const leadWritable = ['email','first_name','last_name','company','country','job_title','phone','linkedin_url','website','industry','source','notes','lead_status'];
const campaignWritable = ['name','sequence_id','sender_display_name'];

async function campaign(req: Request) {
  return requireFound(db(await supabase.from('campaigns').select(campaignFields).eq('id', uuid(req.params.id)).eq('operator_id', tenant(req)).maybeSingle()));
}

async function sequenceIds(operatorId: string): Promise<string[]> {
  const ids = new Set<string>();
  for (let from = 0; ; from += 1000) {
    const rows = db(await supabase.from('campaigns').select('sequence_id').eq('operator_id', operatorId).range(from, from + 999));
    for (const row of rows ?? []) if (row.sequence_id) ids.add(row.sequence_id);
    if ((rows ?? []).length < 1000) break;
  }
  return Array.from(ids);
}

async function sequenceAllowed(operatorId: string, sequenceId: string) {
  const allowed = await sequenceIds(operatorId);
  if (!allowed.includes(sequenceId)) return false;
  return Boolean(db(await supabase.from('sequences').select('id').eq('id', sequenceId).maybeSingle()));
}

async function idempotent(req: Request, res: Response, execute: () => Promise<{ status: number; data: unknown }>) {
  const provided = req.header('Idempotency-Key');
  if (!provided) { const result = await execute(); return res.status(result.status).json(result.data); }
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(provided)) badRequest('Idempotency-Key must be 8–128 safe characters.');
  const keyId = req.publicApi!.keyId;
  const requestHash = crypto.createHash('sha256').update(`${req.method}:${req.path}:${JSON.stringify(req.body ?? {})}`).digest('hex');
  const reserve = await supabase.from('api_idempotency').insert({ api_key_id: keyId, request_key: provided, request_hash: requestHash }).select('id').single();
  if (reserve.error) {
    if (reserve.error.code !== '23505') throw reserve.error;
    const old = db(await supabase.from('api_idempotency').select('request_hash,status,http_status,response').eq('api_key_id', keyId).eq('request_key', provided).single());
    if (old.request_hash !== requestHash) return apiError(res, 409, 'IDEMPOTENCY_CONFLICT', 'This Idempotency-Key was used with another request.');
    if (old.status === 'complete') return res.status(old.http_status).json(old.response);
    return apiError(res, 409, 'IDEMPOTENCY_IN_PROGRESS', 'This request is still processing; retry shortly.');
  }
  try {
    const result = await execute();
    db(await supabase.from('api_idempotency').update({ status: 'complete', http_status: result.status, response: result.data }).eq('id', reserve.data.id));
    return res.status(result.status).json(result.data);
  } catch (error) {
    await supabase.from('api_idempotency').delete().eq('id', reserve.data.id);
    throw error;
  }
}

router.get('/auth/check', run(async (req, res) => res.json({ key_id: req.publicApi!.keyId, operator_id: tenant(req), scopes: req.publicApi!.scopes })));

router.get('/leads', requireScope('leads:read'), run(async (req, res) => {
  const p = pageInput(req);
  const result = await supabase.from('leads').select(leadFields, { count: 'exact' }).eq('operator_id', tenant(req)).order('created_at', { ascending: false }).range(p.from, p.to);
  db(result); res.json({ page: p.page, page_size: p.pageSize, total: result.count ?? 0, data: result.data ?? [] });
}));
router.post('/leads', requireScope('leads:write'), run(async (req, res) => {
  const input = dto(req.body, leadWritable, ['email']);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(input.email))) badRequest('A valid email is required.');
  return idempotent(req, res, async () => ({ status: 201, data: db(await supabase.from('leads').insert(await handleLeadsBeforeWrite({ ...input, operator_id: tenant(req) }, 'create')).select(leadFields).single()) }));
}));
router.get('/leads/:id', requireScope('leads:read'), run(async (req, res) => res.json(requireFound(db(await supabase.from('leads').select(leadFields).eq('id', uuid(req.params.id)).eq('operator_id', tenant(req)).maybeSingle())))));
router.patch('/leads/:id', requireScope('leads:write'), run(async (req, res) => {
  const input = dto(req.body, leadWritable);
  if (!Object.keys(input).length) badRequest('At least one field is required.');
  if (input.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(input.email))) badRequest('A valid email is required.');
  res.json(requireFound(db(await supabase.from('leads').update(await handleLeadsBeforeWrite(input, 'update')).eq('id', uuid(req.params.id)).eq('operator_id', tenant(req)).select(leadFields).maybeSingle())));
}));
router.delete('/leads/:id', requireScope('leads:write'), run(async (req, res) => {
  requireFound(db(await supabase.from('leads').delete().eq('id', uuid(req.params.id)).eq('operator_id', tenant(req)).select('id').maybeSingle()));
  res.json({ success: true });
}));

router.get('/campaigns', requireScope('campaigns:read'), run(async (req, res) => {
  const p = pageInput(req);
  const result = await supabase.from('campaigns').select(campaignFields, { count: 'exact' }).eq('operator_id', tenant(req)).order('created_at', { ascending: false }).range(p.from, p.to);
  db(result); res.json({ page: p.page, page_size: p.pageSize, total: result.count ?? 0, data: result.data ?? [] });
}));
router.post('/campaigns', requireScope('campaigns:write'), run(async (req, res) => {
  const input = dto(req.body, campaignWritable, ['name', 'sequence_id']);
  if (!(await sequenceAllowed(tenant(req), uuid(String(input.sequence_id))))) return apiError(res, 403, 'SEQUENCE_NOT_AVAILABLE', 'Sequence is not available to this operator.');
  return idempotent(req, res, async () => ({ status: 201, data: db(await supabase.from('campaigns').insert(await handleCampaignBeforeWrite({ ...input, operator_id: tenant(req), status: 'draft' }, 'create')).select(campaignFields).single()) }));
}));
router.get('/campaigns/:id', requireScope('campaigns:read'), run(async (req, res) => res.json(await campaign(req))));
router.patch('/campaigns/:id', requireScope('campaigns:write'), run(async (req, res) => {
  const input = dto(req.body, campaignWritable);
  if (!Object.keys(input).length) badRequest('At least one field is required.');
  const current = await campaign(req);
  if (current.status === 'running') return apiError(res, 409, 'CAMPAIGN_RUNNING', 'Pause the campaign before editing it.');
  if (input.sequence_id && !(await sequenceAllowed(tenant(req), uuid(String(input.sequence_id))))) return apiError(res, 403, 'SEQUENCE_NOT_AVAILABLE', 'Sequence is not available to this operator.');
  res.json(requireFound(db(await supabase.from('campaigns').update(await handleCampaignBeforeWrite(input, 'update')).eq('id', current.id).eq('operator_id', tenant(req)).select(campaignFields).maybeSingle())));
}));
router.post('/campaigns/:id/leads', requireScope('campaigns:write'), run(async (req, res) => {
  const input = dto(req.body, ['lead_ids']);
  if (!Array.isArray(input.lead_ids) || !input.lead_ids.length || input.lead_ids.length > 100 || input.lead_ids.some((value) => typeof value !== 'string')) badRequest('lead_ids must contain 1–100 UUIDs.');
  const ids = Array.from(new Set((input.lead_ids as string[]).map(uuid)));
  const current = await campaign(req);
  const leads = db(await supabase.from('leads').select('id').eq('operator_id', tenant(req)).in('id', ids));
  if (leads.length !== ids.length) return apiError(res, 404, 'LEAD_NOT_FOUND', 'One or more leads do not belong to this operator.');
  return idempotent(req, res, async () => ({ status: 200, data: await attachLeadsToCampaign(current.id, ids) }));
}));
router.post('/campaigns/:id/start', requireScope('campaigns:control'), run(async (req, res) => {
  const current = await campaign(req);
  return idempotent(req, res, async () => { await startCampaign(current.id); return { status: 200, data: { status: 'running' } }; });
}));
router.post('/campaigns/:id/pause', requireScope('campaigns:control'), run(async (req, res) => {
  const current = await campaign(req);
  return idempotent(req, res, async () => { if (current.status !== 'paused') await pauseCampaign(current.id); return { status: 200, data: { status: 'paused' } }; });
}));
router.get('/campaigns/:id/status', requireScope('campaigns:read'), run(async (req, res) => { const current = await campaign(req); res.json({ id: current.id, status: current.status }); }));
router.get('/campaigns/:id/report', requireScope('reports:read'), run(async (req, res) => {
  const current = await campaign(req);
  const byStatus: Record<string, number> = {};
  let total = 0;
  for (let from = 0; ; from += 1000) {
    const rows = db(await supabase.from('campaign_leads').select('status').eq('campaign_id', current.id).range(from, from + 999));
    for (const row of rows ?? []) { byStatus[row.status ?? 'unknown'] = (byStatus[row.status ?? 'unknown'] ?? 0) + 1; total += 1; }
    if ((rows ?? []).length < 1000) break;
  }
  res.json({ campaign_id: current.id, total_leads: total, by_status: byStatus });
}));
router.get('/sequences', requireScope('sequences:read'), run(async (req, res) => {
  const p = pageInput(req), ids = await sequenceIds(tenant(req));
  if (!ids.length) return res.json({ page: p.page, page_size: p.pageSize, total: 0, data: [] });
  const result = await supabase.from('sequences').select(sequenceFields, { count: 'exact' }).in('id', ids).order('created_at', { ascending: false }).range(p.from, p.to);
  db(result); res.json({ page: p.page, page_size: p.pageSize, total: result.count ?? 0, data: result.data ?? [] });
}));
router.get('/sequences/:id', requireScope('sequences:read'), run(async (req, res) => {
  const id = uuid(req.params.id);
  if (!(await sequenceAllowed(tenant(req), id))) return apiError(res, 404, 'NOT_FOUND', 'Sequence not found.');
  res.json(requireFound(db(await supabase.from('sequences').select(sequenceFields).eq('id', id).maybeSingle())));
}));
router.get('/reports/overview', requireScope('reports:read'), run(async (req, res) => {
  const operatorId = tenant(req);
  const [leads, campaigns, campaignLeads] = await Promise.all([
    supabase.from('leads').select('id', { count: 'exact', head: true }).eq('operator_id', operatorId),
    supabase.from('campaigns').select('id', { count: 'exact', head: true }).eq('operator_id', operatorId),
    supabase.from('campaign_leads').select('id,campaigns!inner(operator_id)', { count: 'exact', head: true }).eq('campaigns.operator_id', operatorId),
  ]);
  db(leads); db(campaigns); db(campaignLeads);
  res.json({ leads: leads.count ?? 0, campaigns: campaigns.count ?? 0, campaign_leads: campaignLeads.count ?? 0 });
}));

router.use((_req, res) => apiError(res, 404, 'NOT_FOUND', 'Endpoint not found.'));
export default router;
