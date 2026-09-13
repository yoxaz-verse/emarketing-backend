import { Router } from 'express';
import { requireAuth } from '../middleware/requireAuth';
import { supabase } from '../supabase';
import { API_SCOPES, allowedScopes } from '../publicApi/common';
import { generateKeyMaterial } from '../publicApi/keyMaterial';

const router = Router();
router.use(requireAuth('viewer'));
router.use((req, res, next) => req.auth?.type === 'user' ? next() : res.status(403).json({ error: 'Dashboard session required' }));

const fields = 'id,name,key_prefix,scopes,user_id,operator_id,active,created_at,expires_at,revoked_at,last_used_at,created_by,revoked_by,rotated_from';
const admin = (role?: string) => role === 'admin' || role === 'superadmin';
const safe = (row: any) => ({ ...row, status: row.revoked_at || !row.active ? 'revoked' : row.expires_at && Date.parse(row.expires_at) <= Date.now() ? 'expired' : 'active' });

async function owner(req: any) {
  const { data, error } = await supabase.from('users').select('id,role,operator_id,access_flags,active').eq('id', req.auth.user_id).maybeSingle();
  if (error) throw error;
  if (!data?.active) throw Object.assign(new Error('Account is inactive'), { status: 403 });
  return data;
}

async function createKey(req: any, input: { name: string; scopes: string[]; expires_at?: string | null; operator_id?: string | null; rotated_from?: string | null }) {
  const user = await owner(req);
  const isAdmin = admin(user.role);
  const operatorId = isAdmin ? String(input.operator_id ?? '').trim() : String(user.operator_id ?? '').trim();
  if (!operatorId) throw Object.assign(new Error('An operator is required for API keys.'), { status: 400 });
  if (!isAdmin && input.operator_id && input.operator_id !== operatorId) throw Object.assign(new Error('Cannot select another operator.'), { status: 403 });
  if (isAdmin) {
    const { data: operator, error } = await supabase.from('operators').select('id').eq('id', operatorId).maybeSingle();
    if (error) throw error;
    if (!operator) throw Object.assign(new Error('Operator not found.'), { status: 404 });
  }
  if (!Array.isArray(input.scopes) || input.scopes.length === 0 || input.scopes.some((scope) => typeof scope !== 'string' || !API_SCOPES.includes(scope as any))) {
    throw Object.assign(new Error('Choose one or more valid scopes.'), { status: 400 });
  }
  const scopes = Array.from(new Set(input.scopes));
  if (scopes.some((scope) => !allowedScopes(user.role, user.access_flags).includes(scope as any))) {
    throw Object.assign(new Error('A requested scope exceeds your current access.'), { status: 403 });
  }
  const name = String(input.name ?? '').trim();
  if (!name || name.length > 80) throw Object.assign(new Error('Name must be 1–80 characters.'), { status: 400 });
  const expiry = input.expires_at ? new Date(input.expires_at) : null;
  if (expiry && (!Number.isFinite(expiry.getTime()) || expiry.getTime() <= Date.now())) {
    throw Object.assign(new Error('Expiration must be in the future.'), { status: 400 });
  }
  const { token, keyHash, keyPrefix } = generateKeyMaterial();
  const { data, error } = await supabase.from('api_keys').insert({
    name, key_prefix: keyPrefix, key_hash: keyHash, scopes,
    user_id: user.id, operator_id: operatorId, role: user.role, active: true,
    expires_at: expiry?.toISOString() ?? null, created_by: user.id, rotated_from: input.rotated_from ?? null,
  }).select(fields).single();
  if (error) throw error;
  return { key: safe(data), token };
}

router.get('/', async (req, res) => {
  try {
    const user = await owner(req);
    let query = supabase.from('api_keys').select(fields).not('scopes', 'is', null).order('created_at', { ascending: false });
    if (!admin(user.role)) query = query.eq('user_id', user.id);
    const { data, error } = await query;
    if (error) throw error;
    res.setHeader('Cache-Control', 'no-store');
    const userIds = Array.from(new Set((data ?? []).map((key: any) => key.user_id).filter(Boolean)));
    const owners = userIds.length ? await supabase.from('users').select('id,email').in('id', userIds) : { data: [], error: null };
    if (owners.error) throw owners.error;
    const ownerEmails = new Map((owners.data ?? []).map((item: any) => [item.id, item.email]));
    res.json({ keys: (data ?? []).map((key: any) => ({ ...safe(key), owner_email: ownerEmails.get(key.user_id) ?? null })), available_scopes: allowedScopes(user.role, user.access_flags), operator_id: user.operator_id, is_admin: admin(user.role) });
  } catch (error: any) { res.status(error.status ?? 500).json({ error: error.message ?? 'Unable to list API keys' }); }
});

router.post('/', async (req, res) => {
  try {
    const created = await createKey(req, req.body ?? {});
    res.setHeader('Cache-Control', 'no-store');
    res.status(201).json(created);
  } catch (error: any) { res.status(error.status ?? 500).json({ error: error.message ?? 'Unable to create API key' }); }
});

async function findManageable(req: any, id: string) {
  const user = await owner(req);
  const { data, error } = await supabase.from('api_keys').select(fields).eq('id', id).not('scopes', 'is', null).maybeSingle();
  if (error) throw error;
  if (!data || (!admin(user.role) && data.user_id !== user.id)) throw Object.assign(new Error('API key not found.'), { status: 404 });
  return data;
}

router.post('/:id/revoke', async (req, res) => {
  try {
    const key = await findManageable(req, req.params.id);
    const { error } = await supabase.from('api_keys').update({ active: false, revoked_at: new Date().toISOString(), revoked_by: req.auth?.user_id }).eq('id', key.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (error: any) { res.status(error.status ?? 500).json({ error: error.message ?? 'Unable to revoke API key' }); }
});

router.post('/:id/rotate', async (req, res) => {
  try {
    const prior = await findManageable(req, req.params.id);
    if (!prior.active || prior.revoked_at) return res.status(409).json({ error: 'Only active keys can be rotated.' });
    const user = await owner(req);
    if (prior.user_id !== user.id) return res.status(403).json({ error: 'Only the key owner can rotate it.' });
    const created = await createKey(req, { name: prior.name, scopes: prior.scopes, expires_at: prior.expires_at, operator_id: prior.operator_id, rotated_from: prior.id });
    const { error } = await supabase.from('api_keys').update({ active: false, revoked_at: new Date().toISOString(), revoked_by: req.auth?.user_id }).eq('id', prior.id);
    if (error) {
      await supabase.from('api_keys').update({ active: false, revoked_at: new Date().toISOString() }).eq('id', created.key.id);
      throw error;
    }
    res.setHeader('Cache-Control', 'no-store');
    res.status(201).json(created);
  } catch (error: any) { res.status(error.status ?? 500).json({ error: error.message ?? 'Unable to rotate API key' }); }
});

export default router;
