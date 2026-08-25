import test from 'node:test';
import assert from 'node:assert/strict';
import { formatUnknownError, isConnectivityError, isSchemaDriftError, isSupabaseAuthConfigError } from './errorFormat';

test('formatUnknownError handles native Error values', () => {
  const error = new Error('plain failure');
  assert.deepEqual(formatUnknownError(error), {
    message: 'plain failure',
    name: 'Error',
  });
});

test('formatUnknownError preserves Supabase object error fields', () => {
  const formatted = formatUnknownError({
    message: 'relation does not exist',
    code: '42P01',
    hint: 'apply migration',
    details: 'missing table public.agent_tasks',
    status: 400,
  });

  assert.deepEqual(formatted, {
    message: 'relation does not exist',
    code: '42P01',
    hint: 'apply migration',
    details: 'missing table public.agent_tasks',
    status: 400,
  });
  assert.equal(isSchemaDriftError(formatted), true);
});

test('formatUnknownError preserves nested DNS causes', () => {
  const cause = Object.assign(new Error('getaddrinfo ENOTFOUND thmmscppbyfutqvqquzh.supabase.co'), {
    code: 'ENOTFOUND',
  });
  const error = Object.assign(new TypeError('fetch failed'), { cause });

  const formatted = formatUnknownError(error);
  assert.equal(formatted.message, 'fetch failed');
  assert.equal(formatted.name, 'TypeError');
  assert.equal(formatted.cause?.message, 'getaddrinfo ENOTFOUND thmmscppbyfutqvqquzh.supabase.co');
  assert.equal(formatted.cause?.code, 'ENOTFOUND');
  assert.equal(isConnectivityError(formatted), true);
});

test('isSupabaseAuthConfigError detects stale Supabase API keys', () => {
  assert.equal(isSupabaseAuthConfigError({ message: 'Unregistered API key', status: 401 }), true);
  assert.equal(isSupabaseAuthConfigError({ message: 'Invalid API key', status: 401 }), true);
});

test('isSupabaseAuthConfigError does not classify wrong passwords as config errors', () => {
  assert.equal(isSupabaseAuthConfigError({ message: 'Invalid login credentials', status: 400 }), false);
});
