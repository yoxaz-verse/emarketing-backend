import test from 'node:test';
import assert from 'node:assert/strict';
import { isCampaignMinuteBlocked, normalizeCampaignBatchSize } from './executionThrottle.utils.js';

test('normalizeCampaignBatchSize forces effective batch size to 1', () => {
  const cases = [0, 1, 10];
  for (const input of cases) {
    const result = normalizeCampaignBatchSize(input);
    assert.equal(result.effective_batch_size, 1);
  }
});

test('isCampaignMinuteBlocked allows first send and blocks second in same minute', () => {
  assert.equal(isCampaignMinuteBlocked(0), false);
  assert.equal(isCampaignMinuteBlocked(1), true);
});

test('isCampaignMinuteBlocked allows next minute when sent count resets', () => {
  const sameMinuteBlocked = isCampaignMinuteBlocked(1);
  const nextMinuteAllowed = isCampaignMinuteBlocked(0);
  assert.equal(sameMinuteBlocked, true);
  assert.equal(nextMinuteAllowed, false);
});
