import test from 'node:test';
import assert from 'node:assert/strict';
import { isCampaignAttachableEligibility, isCampaignLeadAttachableState } from '../campaign.domain.js';

test('campaign attach eligibility includes risky and qualified statuses', () => {
  assert.equal(isCampaignAttachableEligibility('eligible'), true);
  assert.equal(isCampaignAttachableEligibility('valid'), true);
  assert.equal(isCampaignAttachableEligibility('validated'), true);
  assert.equal(isCampaignAttachableEligibility('risky'), true);
  assert.equal(isCampaignAttachableEligibility('blocked'), false);
  assert.equal(isCampaignAttachableEligibility('pending'), false);
});

test('campaign lead attach state excludes blocked, permanently failed, and used leads', () => {
  assert.equal(
    isCampaignLeadAttachableState({ email_eligibility: 'risky', permanently_failed: false, is_used: false }),
    true
  );
  assert.equal(
    isCampaignLeadAttachableState({ email_eligibility: 'eligible', permanently_failed: true, is_used: false }),
    false
  );
  assert.equal(
    isCampaignLeadAttachableState({ email_eligibility: 'eligible', permanently_failed: false, is_used: true }),
    false
  );
  assert.equal(
    isCampaignLeadAttachableState({ email_eligibility: 'blocked', permanently_failed: false, is_used: false }),
    false
  );
});
