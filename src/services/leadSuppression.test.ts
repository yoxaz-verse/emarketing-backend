import test from 'node:test';
import assert from 'node:assert/strict';
import { isLeadSuppressed } from './leadSuppression.js';

test('suppression is independent from validation eligibility', () => {
  assert.equal(isLeadSuppressed({ is_suppressed: true, suppression_reason: 'user_unsubscribed_campaign' }), true);
  assert.equal(isLeadSuppressed({ is_suppressed: false, suppression_reason: null }), false);
  assert.equal(isLeadSuppressed({ is_suppressed: false, suppression_reason: 'manual_suppression' }), true);
});
