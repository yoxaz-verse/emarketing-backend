import test from 'node:test';
import assert from 'node:assert/strict';
import { supabase } from '../../supabase';
import { processDueSocialPublishJobs } from './social.service';

function query(result: () => unknown) {
  const q: any = {};
  for (const method of ['select', 'eq', 'lte', 'lt', 'not', 'order', 'limit', 'update']) q[method] = () => q;
  q.maybeSingle = async () => result();
  q.single = async () => result();
  q.then = (resolve: (value: unknown) => unknown) => Promise.resolve(result()).then(resolve);
  return q;
}

test('due runner does not execute a job claimed by another worker', async (t) => {
  let claimed = 0;
  const due = { id: 'post-1', status: 'scheduled', scheduled_at: '2026-09-14T21:45:00Z', timeline: [], attempts: 0 };
  t.mock.method(supabase, 'from', (table: string) => {
    assert.equal(table, 'social_publish_jobs');
    const index = claimed++;
    if (index === 0) return query(() => ({ data: [], error: null }));
    if (index === 1) return query(() => ({ data: [due], error: null }));
    return query(() => ({ data: null, error: null }));
  });
  const result = await processDueSocialPublishJobs();
  assert.equal(result.processed, 0);
  assert.equal(claimed, 3);
});

test('claimed job records an actionable failure if connector lookup fails', async (t) => {
  const due = { id: 'post-1', status: 'scheduled', scheduled_at: '2026-09-14T21:45:00Z', timeline: [], attempts: 0 };
  let failurePatch: any;
  let jobCalls = 0;
  t.mock.method(supabase, 'from', (table: string) => {
    if (table === 'social_connectors') return query(() => ({ data: null, error: new Error('Connector missing') }));
    assert.equal(table, 'social_publish_jobs');
    const index = jobCalls++;
    if (index === 0) return query(() => ({ data: [], error: null }));
    if (index === 1) return query(() => ({ data: [due], error: null }));
    if (index === 2) return query(() => ({ data: { ...due, status: 'draft_created', platform_code: 'linkedin' }, error: null }));
    const q = query(() => ({ data: { ...due, status: 'failed' }, error: null }));
    q.update = (patch: unknown) => { failurePatch = patch; return q; };
    return q;
  });
  const result = await processDueSocialPublishJobs();
  assert.equal(result.processed, 1);
  assert.equal(failurePatch.status, 'failed');
  assert.match(failurePatch.error_message, /Connector missing.*before retrying/i);
});
