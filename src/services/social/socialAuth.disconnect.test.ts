import test from 'node:test';
import assert from 'node:assert/strict';
import { supabase } from '../../supabase.js';
import { encryptSocialSecret } from '../../utils/socialIntegrationEncryption.js';
import { disconnectPlatform, recheckLinkedInIdentity } from './socialAuth.service.js';

test('disconnect removes only the selected user and operator connection', async () => {
  const originalFrom = supabase.from;
  const rows = [
    { platform_code: 'linkedin', user_id: 'user-1', operator_id: 'operator-1' },
    { platform_code: 'linkedin', user_id: 'user-1', operator_id: 'operator-2' },
  ];
  const updates: Record<string, unknown>[] = [];
  (supabase as any).from = (table: string) => {
    let operation = '';
    const filters: Record<string, string> = {};
    const query: any = {
      delete() { operation = 'delete'; return query; },
      select() { operation = 'select'; return query; },
      update(value: Record<string, unknown>) { operation = 'update'; updates.push(value); return query; },
      eq(key: string, value: string) { filters[key] = value; return query; },
      then(resolve: (value: unknown) => void) {
        if (table === 'social_oauth_connections' && operation === 'delete') {
          const index = rows.findIndex((row) => Object.entries(filters).every(([key, value]) => (row as any)[key] === value));
          if (index >= 0) rows.splice(index, 1);
          return resolve({ error: null });
        }
        if (table === 'social_oauth_connections' && operation === 'select') {
          return resolve({ count: rows.filter((row) => row.platform_code === filters.platform_code).length, error: null });
        }
        return resolve({ error: null });
      },
    };
    return query;
  };
  try {
    assert.deepEqual(await disconnectPlatform('linkedin', 'user-1', 'operator-1'), { success: true });
    assert.deepEqual(rows, [{ platform_code: 'linkedin', user_id: 'user-1', operator_id: 'operator-2' }]);
    assert.equal(updates[0]?.credentials_active, true);
  } finally {
    (supabase as any).from = originalFrom;
  }
});

test('disconnect surfaces a database deletion failure', async () => {
  const originalFrom = supabase.from;
  (supabase as any).from = () => {
    const query: any = {
      delete() { return query; },
      eq() { return query; },
      then(resolve: (value: unknown) => void) { return resolve({ error: new Error('delete failed') }); },
    };
    return query;
  };
  try {
    await assert.rejects(() => disconnectPlatform('linkedin', 'user-1', 'operator-1'), /delete failed/);
  } finally {
    (supabase as any).from = originalFrom;
  }
});

test('rechecking a saved LinkedIn token updates only its owner and clears stale identity errors', async () => {
  const originalFrom = supabase.from;
  const originalFetch = globalThis.fetch;
  const saved = {
    id: 'connection-1', platform_code: 'linkedin', user_id: 'user-1', operator_id: 'operator-1',
    access_token_encrypted: encryptSocialSecret('saved-token'), expires_at: null,
    scopes: ['w_member_social', 'r_profile_basicinfo'],
    metadata: { actor_resolution_error: 'Enter the LinkedIn Member URN fallback', actor_urn_required: true },
  };
  let updated: Record<string, any> | null = null;
  (supabase as any).from = (table: string) => {
    assert.equal(table, 'social_oauth_connections');
    const filters: Record<string, string> = {};
    const query: any = {
      select() { return query; },
      update(value: Record<string, any>) { updated = value; return query; },
      eq(key: string, value: string) { filters[key] = value; return query; },
      maybeSingle() { return Promise.resolve({ data: saved, error: null }); },
      then(resolve: (value: unknown) => void) {
        assert.deepEqual(filters, { id: saved.id, platform_code: 'linkedin', user_id: saved.user_id, operator_id: saved.operator_id });
        return resolve({ error: null });
      },
    };
    return query;
  };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(String(input), 'https://api.linkedin.com/rest/identityMe');
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer saved-token');
    return new Response(JSON.stringify({ id: 'member-1' }), { status: 200 });
  }) as typeof fetch;
  try {
    assert.deepEqual(await recheckLinkedInIdentity('user-1', 'operator-1'), { status: 'connected', reason: null });
    assert.equal((updated as any)?.metadata.actor_urn, 'urn:li:person:member-1');
    assert.equal((updated as any)?.metadata.actor_resolution_error, undefined);
    assert.equal((updated as any)?.metadata.actor_urn_required, undefined);
  } finally {
    (supabase as any).from = originalFrom;
    globalThis.fetch = originalFetch;
  }
});
