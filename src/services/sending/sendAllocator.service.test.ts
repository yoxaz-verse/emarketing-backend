import test from 'node:test';
import assert from 'node:assert/strict';
import { selectStrictRotationCandidate } from './sendAllocator.service.js';

type Candidate = { inbox_id: string };

test('strict rotation selects exact minute-slot inbox when all inboxes are eligible', () => {
  const inboxIds = ['inbox-1', 'inbox-2', 'inbox-3', 'inbox-4', 'inbox-5'];
  const candidates: Candidate[] = inboxIds.map((inbox_id) => ({ inbox_id }));

  for (let minuteBucket = 0; minuteBucket < 15; minuteBucket += 1) {
    const result = selectStrictRotationCandidate({
      candidates,
      inboxIds,
      minuteBucket,
    });
    const expectedInboxId = inboxIds[minuteBucket % inboxIds.length];
    assert.equal(result.targetInboxId, expectedInboxId);
    assert.equal(result.selected?.inbox_id ?? null, expectedInboxId);
    assert.equal(result.reason, 'eligible_sender_found');
    assert.equal(result.rotation_fallback_used, false);
    assert.equal(result.rotation_block_reason, null);
  }
});

test('strict rotation skips minute when target inbox is ineligible', () => {
  const inboxIds = ['inbox-1', 'inbox-2', 'inbox-3', 'inbox-4', 'inbox-5'];
  const candidates: Candidate[] = [
    { inbox_id: 'inbox-1' },
    { inbox_id: 'inbox-2' },
    { inbox_id: 'inbox-4' },
    { inbox_id: 'inbox-5' },
  ];

  const result = selectStrictRotationCandidate({
    candidates,
    inboxIds,
    minuteBucket: 2,
  });

  assert.equal(result.targetInboxId, 'inbox-3');
  assert.equal(result.selected, null);
  assert.equal(result.reason, 'rotation_target_inbox_ineligible');
  assert.equal(result.rotation_fallback_used, false);
  assert.equal(result.rotation_block_reason, 'rotation_target_inbox_ineligible');
});

test('strict rotation never falls back to other eligible inboxes across minutes', () => {
  const inboxIds = ['inbox-1', 'inbox-2', 'inbox-3', 'inbox-4', 'inbox-5'];

  const minute0 = selectStrictRotationCandidate({
    candidates: [{ inbox_id: 'inbox-1' }, { inbox_id: 'inbox-4' }],
    inboxIds,
    minuteBucket: 0,
  });
  assert.equal(minute0.selected?.inbox_id ?? null, 'inbox-1');
  assert.equal(minute0.reason, 'eligible_sender_found');

  const minute1 = selectStrictRotationCandidate({
    candidates: [{ inbox_id: 'inbox-1' }, { inbox_id: 'inbox-4' }],
    inboxIds,
    minuteBucket: 1,
  });
  assert.equal(minute1.targetInboxId, 'inbox-2');
  assert.equal(minute1.selected, null);
  assert.equal(minute1.reason, 'rotation_target_inbox_ineligible');
  assert.equal(minute1.rotation_fallback_used, false);

  const minute3 = selectStrictRotationCandidate({
    candidates: [{ inbox_id: 'inbox-1' }, { inbox_id: 'inbox-4' }],
    inboxIds,
    minuteBucket: 3,
  });
  assert.equal(minute3.selected?.inbox_id ?? null, 'inbox-4');
  assert.equal(minute3.reason, 'eligible_sender_found');
});
