import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePagination, normalizeSortOrder } from './pagination';

test('pagination applies defaults and calculates offsets', () => {
  assert.deepEqual(normalizePagination(undefined, undefined), { page: 1, pageSize: 25, offset: 0 });
  assert.deepEqual(normalizePagination('3', '50'), { page: 3, pageSize: 50, offset: 100 });
});

test('pagination rejects invalid ranges by clamping to safe bounds', () => {
  assert.deepEqual(normalizePagination('-9', '1000'), { page: 1, pageSize: 100, offset: 0 });
  assert.deepEqual(normalizePagination('2', '0'), { page: 2, pageSize: 25, offset: 25 });
});

test('sort order only accepts ascending explicitly', () => {
  assert.equal(normalizeSortOrder('asc'), 'asc');
  assert.equal(normalizeSortOrder('DESC'), 'desc');
  assert.equal(normalizeSortOrder('unexpected'), 'desc');
});
