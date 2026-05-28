import test from 'node:test';
import assert from 'node:assert/strict';
import { canPassPreSendEligibility } from './preSendGate.service.js';

test('pre-send eligibility allows eligible and risky leads', () => {
  assert.equal(canPassPreSendEligibility('eligible'), true);
  assert.equal(canPassPreSendEligibility('risky'), true);
});

test('pre-send eligibility blocks invalid states', () => {
  assert.equal(canPassPreSendEligibility('pending'), false);
  assert.equal(canPassPreSendEligibility('blocked'), false);
  assert.equal(canPassPreSendEligibility('invalid'), false);
  assert.equal(canPassPreSendEligibility(null), false);
});
