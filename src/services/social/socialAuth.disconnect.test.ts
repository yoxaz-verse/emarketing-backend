import test from 'node:test';
import assert from 'node:assert/strict';
import { supabase } from '../../supabase.js';
import { disconnectPlatform } from './socialAuth.service.js';

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
