import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deleteCampaignDependents,
  getCampaignDeletePreview,
} from '../campaignDelete.service.js';
import { supabase } from '../../supabase.js';

type MockState = {
  campaign?: any;
  counts?: Record<string, number>;
  campaignLeadIds?: string[];
  calls: Array<{ table: string; operation: string; column?: string; value?: unknown }>;
};

function installSupabaseMock(t: test.TestContext, state: MockState) {
  t.mock.method(supabase, 'from', (table: string) => {
    const builder: any = {
      _operation: '',
      select() {
        this._operation = 'select';
        return this;
      },
      delete() {
        this._operation = 'delete';
        return this;
      },
      eq(column: string, value: unknown) {
        state.calls.push({ table, operation: this._operation, column, value });

        if (table === 'campaigns' || table === 'system_events') {
          return this;
        }

        if (this._operation === 'delete') {
          return Promise.resolve({ error: null });
        }

        if (table === 'campaign_leads' && column === 'campaign_id') {
          const data = (state.campaignLeadIds ?? []).map((id) => ({ id }));
          return Promise.resolve({ data, count: state.counts?.[table] ?? data.length, error: null });
        }

        return Promise.resolve({ count: state.counts?.[table] ?? 0, error: null });
      },
      in(column: string, value: unknown) {
        state.calls.push({ table, operation: this._operation, column, value });
        if (table === 'system_events' && this._operation === 'select') {
          return Promise.resolve({ count: state.counts?.[table] ?? 0, error: null });
        }
        return Promise.resolve({ error: null });
      },
      maybeSingle() {
        return Promise.resolve({ data: state.campaign ?? null, error: null });
      },
    };

    return builder;
  });
}

test('campaign delete preview returns counts for a paused campaign', async (t) => {
  const state: MockState = {
    campaign: { id: 'campaign-1', name: 'Demo Campaign', status: 'paused' },
    counts: {
      campaign_leads: 12,
      campaign_inboxes: 2,
      campaign_voice_agents: 1,
      email_logs: 30,
      email_tracking_events: 44,
      system_events: 5,
    },
    calls: [],
  };
  installSupabaseMock(t, state);

  const preview = await getCampaignDeletePreview('campaign-1');

  assert.equal(preview.canDelete, true);
  assert.equal(preview.blocker, undefined);
  assert.deepEqual(preview.campaign, { id: 'campaign-1', name: 'Demo Campaign', status: 'paused' });
  assert.deepEqual(preview.deletes, {
    campaigns: 1,
    campaign_leads: 12,
    campaign_inboxes: 2,
    campaign_voice_agents: 1,
    email_logs: 30,
    email_tracking_events: 44,
    system_events: 5,
  });
});

test('campaign delete preview blocks running campaigns', async (t) => {
  const state: MockState = {
    campaign: { id: 'campaign-1', name: 'Running Campaign', status: 'running' },
    counts: {},
    calls: [],
  };
  installSupabaseMock(t, state);

  const preview = await getCampaignDeletePreview('campaign-1');

  assert.equal(preview.canDelete, false);
  assert.equal(preview.blocker, 'Pause this campaign before deleting.');
});

test('campaign delete preview returns 404 for a missing campaign', async (t) => {
  const state: MockState = { campaign: null, counts: {}, calls: [] };
  installSupabaseMock(t, state);

  await assert.rejects(
    () => getCampaignDeletePreview('missing-campaign'),
    (error: any) => error?.statusCode === 404 && error?.message === 'Campaign not found'
  );
});

test('campaign dependent delete removes tracking and logs before campaign links', async (t) => {
  const state: MockState = {
    campaign: { id: 'campaign-1', status: 'paused' },
    campaignLeadIds: ['lead-1', 'lead-2'],
    calls: [],
  };
  installSupabaseMock(t, state);

  await deleteCampaignDependents('campaign-1');

  const deletes = state.calls
    .filter((call) => call.operation === 'delete')
    .map((call) => `${call.table}.${call.column}`);

  assert.deepEqual(deletes, [
    'email_tracking_events.campaign_lead_id',
    'email_tracking_events.campaign_id',
    'email_logs.campaign_lead_id',
    'email_logs.campaign_id',
    'campaign_voice_agents.campaign_id',
    'campaign_inboxes.campaign_id',
    'campaign_leads.campaign_id',
    'system_events.entity_id',
    'system_events.entity',
  ]);
  assert.equal(deletes.some((item) => item.startsWith('leads.')), false);
  assert.equal(deletes.some((item) => item.startsWith('inboxes.')), false);
  assert.equal(deletes.some((item) => item.startsWith('voice_agents.')), false);
});

test('campaign dependent delete blocks running campaigns', async (t) => {
  const state: MockState = {
    campaign: { id: 'campaign-1', status: 'running' },
    campaignLeadIds: ['lead-1'],
    calls: [],
  };
  installSupabaseMock(t, state);

  await assert.rejects(
    () => deleteCampaignDependents('campaign-1'),
    (error: any) =>
      error?.statusCode === 409 &&
      error?.message === 'Cannot delete a running campaign. Pause it first.'
  );

  assert.equal(state.calls.some((call) => call.operation === 'delete'), false);
});
