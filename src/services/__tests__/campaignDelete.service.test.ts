import test from 'node:test';
import assert from 'node:assert/strict';
import { deleteCampaigns, getCampaignDeletePreview } from '../campaignDelete.service.js';
import { supabase } from '../../supabase.js';

test('preview passes operator scope and returns the complete impact', async (t) => {
  t.mock.method(supabase, 'rpc', async (name: string, args: any) => {
    assert.equal(name, 'campaign_delete_preview');
    assert.deepEqual(args, { p_campaign_id: 'campaign-1', p_operator_id: 'operator-1' });
    return { data: { campaign: { id: 'campaign-1', name: 'Demo', status: 'paused' }, canDelete: true,
      deletes: { campaigns: 1, voice_calls: 3, communication_messages: 10, communication_queue: 2 }, preserves: ['leads'] }, error: null };
  });
  const preview = await getCampaignDeletePreview('campaign-1', { role: 'operator', operator_id: 'operator-1' });
  assert.equal(preview.deletes.communication_messages, 10);
  assert.equal(preview.canDelete, true);
});

test('admin bulk delete deduplicates IDs and delegates atomically', async (t) => {
  t.mock.method(supabase, 'rpc', async (name: string, args: any) => {
    assert.equal(name, 'delete_campaigns_with_data');
    assert.deepEqual(args, { p_campaign_ids: ['a', 'b'], p_operator_id: null });
    return { data: 2, error: null };
  });
  assert.equal(await deleteCampaigns(['a', 'b', 'a'], { role: 'superadmin' }), 2);
});

test('operator without scope cannot preview or delete', async (t) => {
  t.mock.method(supabase, 'rpc', async () => { throw new Error('RPC should not be called'); });
  await assert.rejects(() => getCampaignDeletePreview('a', { role: 'operator' }), /Operator access required/);
  await assert.rejects(() => deleteCampaigns(['a'], { role: 'operator' }), /Operator access required/);
});

test('missing, out-of-scope and running errors are actionable', async (t) => {
  const rpc = t.mock.method(supabase, 'rpc', async () => ({ data: null, error: { message: 'Campaign not found or outside your operator scope' } }));
  await assert.rejects(() => deleteCampaigns(['a'], { role: 'admin' }), (e: any) => e.statusCode === 404);
  rpc.mock.mockImplementation(async () => ({ data: null, error: { message: 'Pause campaign "A" before deleting.' } }));
  await assert.rejects(() => deleteCampaigns(['a'], { role: 'admin' }), (e: any) => e.statusCode === 409);
});
