import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyReplyCaptureInbox,
  deriveReplyCaptureStatus,
  planUidFetch,
  sanitizeImapError,
} from './replyCapture.utils';

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

test('classifies incomplete inbox configuration without returning secrets', () => {
  assert.equal(classifyReplyCaptureInbox({ smtp_accounts: null }), 'missing_smtp_account');
  assert.equal(classifyReplyCaptureInbox({ smtp_accounts: { username: 'user', password: 'secret' } }), 'missing_host');
  assert.equal(classifyReplyCaptureInbox({ smtp_accounts: { host: 'imap.example.com', password: 'secret' } }), 'missing_username');
  assert.equal(classifyReplyCaptureInbox({ smtp_accounts: { host: 'imap.example.com', username: 'user' } }), 'missing_password');
  assert.equal(classifyReplyCaptureInbox({ smtp_accounts: { username: 'user', password: 'secret' } }, 'imap.example.com'), null);
});

test('derives disabled, misconfigured, failed, stale, and healthy states', () => {
  const base = {
    enabled: true,
    eligibleInboxCount: 1,
    failedInboxCount: 0,
    lastCycleError: null,
    lastCycleAt: '2026-10-12T00:00:00.000Z',
    lastPollAt: '2026-10-12T00:00:00.000Z',
    stale: false,
  };
  assert.equal(deriveReplyCaptureStatus({ ...base, enabled: false }), 'disabled');
  assert.equal(deriveReplyCaptureStatus({ ...base, eligibleInboxCount: 0 }), 'misconfigured');
  assert.equal(deriveReplyCaptureStatus({ ...base, failedInboxCount: 1 }), 'failed');
  assert.equal(deriveReplyCaptureStatus({ ...base, lastCycleError: 'database unavailable' }), 'failed');
  assert.equal(deriveReplyCaptureStatus({ ...base, lastPollAt: null }), 'failed');
  assert.equal(deriveReplyCaptureStatus({ ...base, stale: true }), 'stale');
  assert.equal(deriveReplyCaptureStatus(base), 'healthy');
});
