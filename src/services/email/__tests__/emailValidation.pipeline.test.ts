import assert from 'node:assert/strict';
import test from 'node:test';
import {
  toLegacyStatus,
  detectProvider,
  getSuggestion,
  isRoleBasedLocalPart,
} from '../emailValidation.pipeline';

test('maps canonical statuses to legacy statuses', () => {
  assert.equal(toLegacyStatus('valid'), 'eligible');
  assert.equal(toLegacyStatus('risky'), 'risky');
  assert.equal(toLegacyStatus('invalid'), 'blocked');
});

test('detects known MX providers from host patterns', () => {
  assert.equal(detectProvider(['aspmx.l.google.com']), 'google');
  assert.equal(detectProvider(['mx1.mxroute.com']), 'mxroute');
  assert.equal(detectProvider(['foo.protection.outlook.com']), 'microsoft');
  assert.equal(detectProvider(['mail.custom-provider.tld']), null);
});

test('returns typo suggestions for common provider domain mistakes', () => {
  assert.equal(getSuggestion('gamil.com'), 'gmail.com');
  assert.equal(getSuggestion('yaho.com'), 'yahoo.com');
  assert.equal(getSuggestion('example.com'), null);
});

test('flags role-based local parts', () => {
  assert.equal(isRoleBasedLocalPart('sales'), true);
  assert.equal(isRoleBasedLocalPart('No-Reply'), true);
  assert.equal(isRoleBasedLocalPart('john.doe'), false);
});
