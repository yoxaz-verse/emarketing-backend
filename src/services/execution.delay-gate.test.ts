import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateLeadSequenceDelay } from './execution.service.js';

test('step 2 is blocked when delay_days=2 and last_sent_at is 1 day ago', () => {
  const nowMs = Date.UTC(2026, 5, 1, 12, 0, 0);
  const oneDayAgoIso = new Date(nowMs - (24 * 60 * 60 * 1000)).toISOString();

  const result = evaluateLeadSequenceDelay({
    currentStepRaw: 2,
    lastSentAtRaw: oneDayAgoIso,
    delayDaysRaw: 2,
    nowMs,
  });

  assert.equal(result.eligible, false);
  assert.equal(result.blockedReason, 'sequence_delay_not_elapsed');
  assert.ok(result.nextEligibleAt);
});

test('step 2 becomes eligible when delay window is elapsed', () => {
  const nowMs = Date.UTC(2026, 5, 3, 12, 0, 0);
  const twoDaysAgoIso = new Date(nowMs - (2 * 24 * 60 * 60 * 1000)).toISOString();

  const result = evaluateLeadSequenceDelay({
    currentStepRaw: 2,
    lastSentAtRaw: twoDaysAgoIso,
    delayDaysRaw: 2,
    nowMs,
  });

  assert.equal(result.eligible, true);
  assert.equal(result.nextEligibleAt, null);
});

test('step 1 is immediately eligible regardless of last_sent_at', () => {
  const result = evaluateLeadSequenceDelay({
    currentStepRaw: 1,
    lastSentAtRaw: null,
    delayDaysRaw: 99,
  });

  assert.equal(result.eligible, true);
  assert.equal(result.nextEligibleAt, null);
});

test('null delay_days is treated as 0', () => {
  const nowMs = Date.UTC(2026, 5, 1, 12, 0, 0);
  const sameMomentIso = new Date(nowMs).toISOString();

  const result = evaluateLeadSequenceDelay({
    currentStepRaw: 2,
    lastSentAtRaw: sameMomentIso,
    delayDaysRaw: null,
    nowMs,
  });

  assert.equal(result.eligible, true);
});
