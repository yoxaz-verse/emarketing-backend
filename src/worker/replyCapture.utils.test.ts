import assert from 'node:assert/strict';
import test from 'node:test';

import { planUidFetch, sanitizeImapError } from './replyCapture.utils';

test('does not issue a fetch for an empty mailbox', () => {
  assert.equal(planUidFetch(0, 0), null);
});

test('does not issue a fetch when the cursor is already current', () => {
  assert.equal(planUidFetch(9001, 9001), null);
  assert.equal(planUidFetch(9002, 9001), null);
});

test('plans sparse and high mailbox ranges using UIDs', () => {
  assert.equal(planUidFetch(41, 9_000_000), '42:9000000');
});

test('sanitizes credentials while preserving an IMAP error code', () => {
  const result = sanitizeImapError({
    message: 'Command failed password=top-secret',
    responseStatus: 'NO',
  });
  assert.equal(result.code, 'NO');
  assert.doesNotMatch(result.message, /top-secret/);
});
