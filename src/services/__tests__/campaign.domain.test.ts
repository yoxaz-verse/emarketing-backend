import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isCampaignAttachableEligibility,
  isCampaignLeadAttachableState,
  isStartupRequeueableCampaignLead,
  startCampaign,
} from '../campaign.domain.js';
import { supabase } from '../../supabase.js';

test('campaign attach eligibility includes risky and qualified statuses', () => {
  assert.equal(isCampaignAttachableEligibility('eligible'), true);
  assert.equal(isCampaignAttachableEligibility('valid'), true);
  assert.equal(isCampaignAttachableEligibility('validated'), true);
  assert.equal(isCampaignAttachableEligibility('risky'), true);
  assert.equal(isCampaignAttachableEligibility('blocked'), false);
  assert.equal(isCampaignAttachableEligibility('pending'), false);
});

test('campaign lead attach state excludes blocked, permanently failed, and used leads', () => {
  assert.equal(
    isCampaignLeadAttachableState({ email_eligibility: 'risky', permanently_failed: false, is_used: false }),
    true
  );
  assert.equal(
    isCampaignLeadAttachableState({ email_eligibility: 'eligible', permanently_failed: true, is_used: false }),
    false
  );
  assert.equal(
    isCampaignLeadAttachableState({ email_eligibility: 'eligible', permanently_failed: false, is_used: true }),
    false
  );
  assert.equal(
    isCampaignLeadAttachableState({ email_eligibility: 'blocked', permanently_failed: false, is_used: false }),
    false
  );
  assert.equal(
    isCampaignLeadAttachableState({ email_eligibility: 'eligible', permanently_failed: false, is_used: false, is_suppressed: true }),
    false
  );
});

test('startup requeue allows pending campaign leads', () => {
  assert.equal(
    isStartupRequeueableCampaignLead({
      status: 'pending',
      status_reason: 'any_pending_reason',
      last_sent_at: new Date().toISOString(),
      current_step: 3,
    }),
    true
  );
});

test('startup requeue allows unsent paused first-step leads without a protected reason', () => {
  assert.equal(
    isStartupRequeueableCampaignLead({
      status: 'paused',
      status_reason: null,
      last_sent_at: null,
      current_step: 1,
    }),
    true
  );
  assert.equal(
    isStartupRequeueableCampaignLead({
      status: 'paused',
      status_reason: '',
      last_sent_at: '',
      current_step: null,
    }),
    true
  );
});

test('startup requeue restores retired deliverability pauses but protects unsubscribes', () => {
  assert.equal(
    isStartupRequeueableCampaignLead({
      status: 'paused',
      status_reason: 'auth_not_provider_safe',
      last_sent_at: null,
      current_step: 1,
    }),
    true
  );
  assert.equal(
    isStartupRequeueableCampaignLead({
      status: 'paused',
      status_reason: 'user_unsubscribed_campaign',
      last_sent_at: null,
      current_step: 1,
    }),
    false
  );
});

test('startup requeue blocks already-sent paused leads', () => {
  assert.equal(
    isStartupRequeueableCampaignLead({
      status: 'paused',
      status_reason: null,
      last_sent_at: '2026-06-24T10:00:00.000Z',
      current_step: 1,
    }),
    false
  );
});

test('startCampaign repairs safe startup-paused leads when campaign is already running', async (t) => {
  const calls: Array<{ table: string; operation: string; payload?: any }> = [];

  t.mock.method(supabase, 'from', (table: string) => {
    calls.push({ table, operation: 'from' });

    if (table === 'campaigns') {
      return {
        select() { return this; },
        eq() { return this; },
        async single() {
          return { data: { id: 'campaign-1', status: 'running' }, error: null };
        },
      };
    }

    if (table === 'campaign_leads') {
      return {
        _mode: '',
        select() {
          this._mode = 'select';
          return this;
        },
        update(payload: any) {
          calls.push({ table, operation: 'update', payload });
          this._mode = 'update';
          return this;
        },
        eq() { return this; },
        async or() {
          return {
            data: [
              {
                id: 'campaign-lead-1',
                status: 'paused',
                status_reason: null,
                last_sent_at: null,
                current_step: 1,
              },
            ],
            error: null,
          };
        },
        async in() {
          return { error: null };
        },
      };
    }

    if (table === 'system_events') {
      return {
        async insert(payload: any) {
          calls.push({ table, operation: 'insert', payload });
          return { error: null };
        },
      };
    }

    throw new Error(`Unexpected table ${table}`);
  });

  await startCampaign('campaign-1');

  const updateCall = calls.find((call) => call.table === 'campaign_leads' && call.operation === 'update');
  assert.ok(updateCall);
  assert.equal(updateCall?.payload.status, 'queued');
  assert.equal(updateCall?.payload.status_reason, 'startup_requeued');
  assert.equal(updateCall?.payload.processing_at, null);
  assert.equal(updateCall?.payload.execution_id, null);
  assert.ok(calls.some((call) => call.table === 'system_events' && call.operation === 'insert'));
});
