import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCampaignMessageId,
  buildCampaignUnsubscribeToken,
  buildListUnsubscribeHeaders,
  classifyRecipientProvider,
  hasEnforcedDmarcPolicy,
  isProviderSafeAuthReady,
  parseCampaignUnsubscribeToken,
  resolveDeliverabilityPolicy,
} from './deliverabilityPolicy.service';

test('classifies recipient domains into mailbox providers', () => {
  assert.equal(classifyRecipientProvider('a@outlook.com'), 'microsoft');
  assert.equal(classifyRecipientProvider('a@gmail.com'), 'google');
  assert.equal(classifyRecipientProvider('a@yahoo.com'), 'yahoo_aol');
  assert.equal(classifyRecipientProvider('a@example.com'), 'generic');
});

test('requires enforced DMARC for provider-safe auth readiness', () => {
  assert.equal(hasEnforcedDmarcPolicy('reject'), true);
  assert.equal(hasEnforcedDmarcPolicy('quarantine'), true);
  assert.equal(hasEnforcedDmarcPolicy('none'), false);
  assert.equal(isProviderSafeAuthReady({
    spfVerified: true,
    dkimVerified: true,
    dmarcVerified: true,
    dmarcPolicy: 'reject',
  }), true);
  assert.equal(isProviderSafeAuthReady({
    spfVerified: true,
    dkimVerified: true,
    dmarcVerified: true,
    dmarcPolicy: 'none',
  }), false);
});

test('provider policy downgrades tracking and enforces team sender on sensitive providers', () => {
  const policy = resolveDeliverabilityPolicy({
    recipientEmail: 'lead@outlook.com',
    firstTouch: true,
    senderDisplayName: 'Jacob',
    subject: 'URGENT REQUEST!!!',
    body: 'Hello there!!\n\nRegards, Jacob',
    providerSafeAuth: {
      spfVerified: true,
      dkimVerified: true,
      dmarcVerified: true,
      dmarcPolicy: 'reject',
    },
  });

  assert.equal(policy.provider, 'microsoft');
  assert.equal(policy.minimalTracking, true);
  assert.equal(policy.useMultipartPlainText, true);
  assert.equal(policy.effectiveSenderDisplayName, 'OBAOL Team');
  assert.equal(policy.sanitizedBody.includes('Jacob'), false);
});

test('provider policy blocks sensitive sends when auth is not provider-safe', () => {
  const policy = resolveDeliverabilityPolicy({
    recipientEmail: 'lead@yahoo.com',
    firstTouch: true,
    senderDisplayName: 'OBAOL Team',
    subject: 'Hello',
    body: 'Body',
    providerSafeAuth: {
      spfVerified: true,
      dkimVerified: true,
      dmarcVerified: true,
      dmarcPolicy: 'none',
    },
  });

  assert.equal(policy.blockReason, 'auth_not_provider_safe');
});

test('unsubscribe helpers build stable token and headers', () => {
  const token = buildCampaignUnsubscribeToken({
    campaign_id: 'c1',
    campaign_lead_id: 'cl1',
    lead_id: 'l1',
    email: 'lead@example.com',
    exp: Math.floor(Date.now() / 1000) + 3600,
  }, 'secret');
  const parsed = parseCampaignUnsubscribeToken(token, 'secret');
  const headers = buildListUnsubscribeHeaders('https://example.com/execution/unsubscribe?token=abc', 'sender@example.com');

  assert.equal(parsed.campaign_id, 'c1');
  assert.equal(headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
  assert.ok(headers['List-Unsubscribe'].includes('mailto:sender@example.com'));
});

test('message id is stable and uses inbox domain', () => {
  const messageId = buildCampaignMessageId({
    campaignLeadId: 'cl_123',
    inboxEmail: 'sender@obaol.com',
    sentAtIso: '2026-06-02T12:00:00.000Z',
  });

  assert.ok(messageId.endsWith('@obaol.com>'));
});
