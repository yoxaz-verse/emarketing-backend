import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyTrackingEventType,
  normalizeProviderEmailEvent,
} from '../emailTracking.service';

test('normalizes delivered event as delivered', () => {
  const normalized = normalizeProviderEmailEvent({
    event_type: 'delivered',
    message_id: '<msg-1>',
  });

  assert.ok(normalized);
  assert.equal(normalized?.event_type, 'delivered');
});

test('normalizes sent/accepted aliases as delivered', () => {
  const sentNormalized = normalizeProviderEmailEvent({
    event_type: 'sent',
    message_id: '<msg-2>',
  });
  const acceptedNormalized = normalizeProviderEmailEvent({
    event_type: 'accepted',
    message_id: '<msg-3>',
  });

  assert.ok(sentNormalized);
  assert.ok(acceptedNormalized);
  assert.equal(sentNormalized?.event_type, 'delivered');
  assert.equal(acceptedNormalized?.event_type, 'delivered');
});

test('keeps open as open (opened logic untouched)', () => {
  const normalized = normalizeProviderEmailEvent({
    event_type: 'open',
    message_id: '<msg-4>',
  });

  assert.ok(normalized);
  assert.equal(normalized?.event_type, 'open');
});

test('classifies hard and soft bounce correctly', () => {
  assert.equal(classifyTrackingEventType('bounce', '550 5.1.1 user not found'), 'bounced_hard');
  assert.equal(classifyTrackingEventType('bounce', 'mailbox full, try later'), 'bounced_soft');
});

test('open without delivery remains open (not delivered)', () => {
  assert.equal(classifyTrackingEventType('open'), 'open');
  assert.notEqual(classifyTrackingEventType('open'), 'delivered');
});
