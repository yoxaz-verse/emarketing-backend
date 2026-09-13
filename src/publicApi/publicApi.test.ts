import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { generateKeyMaterial } from './keyMaterial';
import { allowedScopes, evaluateApiKey, API_SCOPES } from './keyPolicy';

test('new keys are random, prefixed, and only their hash is retained', () => {
  const first = generateKeyMaterial(), second = generateKeyMaterial();
  assert.match(first.token, /^obaol_live_[a-f0-9]{64}$/);
  assert.notEqual(first.token, second.token);
  assert.equal(first.keyHash, crypto.createHash('sha256').update(first.token).digest('hex'));
  assert.notEqual(first.keyHash, first.token);
  assert.equal(first.keyPrefix, first.token.slice(0, 23));
});

test('effective scopes are the intersection of key grants and current owner access', () => {
  const key = { id: 'key', user_id: 'user', operator_id: 'operator', active: true, scopes: [...API_SCOPES] };
  const owner = { id: 'user', active: true, role: 'viewer', operator_id: 'operator', access_flags: { marketing: true } };
  const verdict = evaluateApiKey(key, owner);
  assert.deepEqual(verdict.context?.scopes, ['leads:read', 'campaigns:read', 'sequences:read', 'reports:read']);
  assert.deepEqual(allowedScopes('user', { marketing: false }), []);
  assert.deepEqual(evaluateApiKey(key, { ...owner, access_flags: { marketing: false } }).context?.scopes, []);
});

test('revoked, expired, disabled-owner, and cross-operator keys fail closed', () => {
  const key = { id: 'key', user_id: 'user', operator_id: 'operator', active: true, scopes: ['leads:read'] };
  const owner = { id: 'user', active: true, role: 'user', operator_id: 'operator', access_flags: { marketing: true } };
  assert.equal(evaluateApiKey({ ...key, active: false }, owner).code, 'INVALID_API_KEY');
  assert.equal(evaluateApiKey({ ...key, revoked_at: '2026-01-01' }, owner).code, 'INVALID_API_KEY');
  assert.equal(evaluateApiKey({ ...key, expires_at: '2026-01-01' }, owner, Date.parse('2026-02-01')).code, 'INVALID_API_KEY');
  assert.equal(evaluateApiKey({ ...key, scopes: null }, owner).code, 'INVALID_API_KEY');
  assert.equal(evaluateApiKey(key, { ...owner, active: false }).code, 'KEY_OWNER_INACTIVE');
  assert.equal(evaluateApiKey(key, { ...owner, operator_id: 'other' }).code, 'KEY_OWNER_INACTIVE');
});

test('OpenAPI operations match registered versioned routes', async () => {
  process.env.SUPABASE_URL ||= 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-service-role-key';
  const { OPENAPI } = await import('./openapi.js');
  const routeModule = await import('../routes/public-v1.routes.js');
  const router = (routeModule as any).default?.default ?? (routeModule as any).default;
  const registered = new Set((router as any).stack.filter((layer: any) => layer.route).flatMap((layer: any) =>
    Object.keys(layer.route.methods).map((method) => `${method.toUpperCase()} ${layer.route.path.replace(/:([a-z]+)/g, '{$1}')}`)));
  for (const [path, methods] of Object.entries(OPENAPI.paths)) {
    for (const method of Object.keys(methods as object)) assert.ok(registered.has(`${method.toUpperCase()} ${path}`), `${method.toUpperCase()} ${path}`);
  }
});

test('scope guard, pagination, and DTO validation reject overreach', async () => {
  process.env.SUPABASE_URL ||= 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-service-role-key';
  const { requireScope, pageInput, dto } = await import('./common.js');
  let nextCalled = false;
  const state: { status?: number; payload?: any } = {};
  const response = { req: { requestId: 'request-1' }, status(value: number) { state.status = value; return this; }, json(value: any) { state.payload = value; return this; } };
  requireScope('leads:write')({ publicApi: { scopes: ['leads:read'] } } as never, response as never, () => { nextCalled = true; });
  assert.equal(state.status, 403);
  assert.equal(state.payload.error.code, 'SCOPE_REQUIRED');
  assert.equal(nextCalled, false);
  requireScope('leads:read')({ publicApi: { scopes: ['leads:read'] } } as never, response as never, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  assert.deepEqual(pageInput({ query: {} } as never), { page: 1, pageSize: 25, from: 0, to: 24 });
  assert.throws(() => pageInput({ query: { page_size: 101 } } as never), /page_size/);
  assert.throws(() => dto({ email: 'a@example.com', operator_id: 'other' }, ['email'], ['email']), /Unknown field/);
  assert.throws(() => dto({ email: 'a@example.com', notes: { privileged: true } }, ['email', 'notes'], ['email']), /must be a string/);
  for (const scope of API_SCOPES) {
    let permitted = false;
    requireScope(scope)({ publicApi: { scopes: [scope] } } as never, response as never, () => { permitted = true; });
    assert.equal(permitted, true, `${scope} should grant its operation`);
    permitted = false;
    requireScope(scope)({ publicApi: { scopes: [] } } as never, response as never, () => { permitted = true; });
    assert.equal(permitted, false, `${scope} should be required`);
  }
});
