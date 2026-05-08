import assert from 'node:assert/strict';
import test from 'node:test';

import {
  hasNonEmptyEmail,
  isBlankEligibility,
  shouldNormalizeLeadEligibility,
} from '../lead.email.validation';

test('normalizes when email exists and eligibility is null/blank', () => {
  assert.equal(shouldNormalizeLeadEligibility({ email: 'info@example.com', email_eligibility: null }), true);
  assert.equal(shouldNormalizeLeadEligibility({ email: 'info@example.com', email_eligibility: '' }), true);
  assert.equal(shouldNormalizeLeadEligibility({ email: 'info@example.com', email_eligibility: '   ' }), true);
});

test('does not normalize rows that are already in stable states', () => {
  assert.equal(shouldNormalizeLeadEligibility({ email: 'info@example.com', email_eligibility: 'pending' }), false);
  assert.equal(shouldNormalizeLeadEligibility({ email: 'info@example.com', email_eligibility: 'eligible' }), false);
  assert.equal(shouldNormalizeLeadEligibility({ email: 'info@example.com', email_eligibility: 'risky' }), false);
  assert.equal(shouldNormalizeLeadEligibility({ email: 'info@example.com', email_eligibility: 'blocked' }), false);
  assert.equal(shouldNormalizeLeadEligibility({ email: 'info@example.com', email_eligibility: 'invalid' }), false);
});

test('does not normalize rows without a usable email', () => {
  assert.equal(shouldNormalizeLeadEligibility({ email: null, email_eligibility: null }), false);
  assert.equal(shouldNormalizeLeadEligibility({ email: '', email_eligibility: null }), false);
  assert.equal(shouldNormalizeLeadEligibility({ email: '   ', email_eligibility: null }), false);
});

test('blank and non-empty helpers enforce shared criteria', () => {
  assert.equal(isBlankEligibility(undefined), true);
  assert.equal(isBlankEligibility('  '), true);
  assert.equal(isBlankEligibility('pending'), false);

  assert.equal(hasNonEmptyEmail('contact@company.com'), true);
  assert.equal(hasNonEmptyEmail('  '), false);
});

