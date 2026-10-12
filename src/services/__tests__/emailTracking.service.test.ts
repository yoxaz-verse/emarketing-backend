import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyDeliveredEvidenceInvariant,
  buildEffectiveDeliveredSets,
  buildEffectiveReplyCounts,
  classifyTrackingEventType,
  groupCampaignEngagement,
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

test('groups engagement by company and filters contacts with opens', () => {
  const result = groupCampaignEngagement({
    status: 'opened',
    page: 1,
    pageSize: 25,
    contacts: [
      {
        campaign_lead_id: 'cl-1', lead_id: 'l-1', email: 'a@acme.test', first_name: 'A', last_name: null, company: 'Acme',
        timeline: [
          { id: 's-1', type: 'sent', occurred_at: '2026-10-10T10:00:00Z', sender_inbox_email: 'sales@test.com', source: 'email_log', detail: null },
          { id: 'o-1', type: 'opened', occurred_at: '2026-10-10T11:00:00Z', sender_inbox_email: 'sales@test.com', source: 'pixel_fallback', detail: null },
        ],
      },
      {
        campaign_lead_id: 'cl-2', lead_id: 'l-2', email: 'b@acme.test', first_name: 'B', last_name: null, company: 'ACME',
        timeline: [{ id: 's-2', type: 'sent', occurred_at: '2026-10-10T09:00:00Z', sender_inbox_email: null, source: 'email_log', detail: null }],
      },
    ],
  });

  assert.equal(result.total, 1);
  assert.equal(result.rows[0]?.company, 'Acme');
  assert.equal(result.rows[0]?.contact_count, 1);
  assert.equal(result.rows[0]?.opens, 1);
});

test('groups missing companies and paginates company rows by latest activity', () => {
  const contact = (id: string, company: string | null, occurredAt: string) => ({
    campaign_lead_id: `cl-${id}`, lead_id: `l-${id}`, email: `${id}@test.com`, first_name: null, last_name: null, company,
    timeline: [{ id: `s-${id}`, type: 'sent' as const, occurred_at: occurredAt, sender_inbox_email: null, source: 'email_log', detail: null }],
  });
  const result = groupCampaignEngagement({
    status: 'all', query: 'company', page: 1, pageSize: 1,
    contacts: [contact('1', null, '2026-10-10T10:00:00Z'), contact('2', 'New company', '2026-10-11T10:00:00Z')],
  });

  assert.equal(result.total, 2);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0]?.company, 'New company');
});

test('classifies hard and soft bounce correctly', () => {
  assert.equal(classifyTrackingEventType('bounce', '550 5.1.1 user not found'), 'bounced_hard');
  assert.equal(classifyTrackingEventType('bounce', 'mailbox full, try later'), 'bounced_soft');
});

test('open without delivery remains open (not delivered)', () => {
  assert.equal(classifyTrackingEventType('open'), 'open');
  assert.notEqual(classifyTrackingEventType('open'), 'delivered');
});

test('sent with no events and no bounce is inferred delivered', () => {
  const computed = buildEffectiveDeliveredSets({
    sentLeadIds: ['l1'],
    confirmedDeliveredLeadIds: [],
    hardBouncedLeadIds: [],
    softBouncedLeadIds: [],
  });
  assert.equal(computed.confirmedDeliveredSet.size, 0);
  assert.equal(computed.inferredDeliveredSet.size, 1);
  assert.equal(computed.effectiveDeliveredSet.size, 1);
});

test('sent + open only is still inferred delivered', () => {
  const computed = buildEffectiveDeliveredSets({
    sentLeadIds: ['l1'],
    confirmedDeliveredLeadIds: [],
    hardBouncedLeadIds: [],
    softBouncedLeadIds: [],
  });
  assert.equal(computed.effectiveDeliveredSet.has('l1'), true);
});

test('sent + reply only is still inferred delivered', () => {
  const computed = buildEffectiveDeliveredSets({
    sentLeadIds: ['l1'],
    confirmedDeliveredLeadIds: [],
    hardBouncedLeadIds: [],
    softBouncedLeadIds: [],
  });
  assert.equal(computed.effectiveDeliveredSet.has('l1'), true);
});

test('bounce excludes delivered even when sent', () => {
  const computed = buildEffectiveDeliveredSets({
    sentLeadIds: ['l1', 'l2'],
    confirmedDeliveredLeadIds: [],
    hardBouncedLeadIds: ['l1'],
    softBouncedLeadIds: [],
  });
  assert.equal(computed.effectiveDeliveredSet.has('l1'), false);
  assert.equal(computed.effectiveDeliveredSet.has('l2'), true);
});

test('explicit delivered webhook remains confirmed delivered', () => {
  const computed = buildEffectiveDeliveredSets({
    sentLeadIds: ['l1'],
    confirmedDeliveredLeadIds: ['l1'],
    hardBouncedLeadIds: [],
    softBouncedLeadIds: [],
  });
  assert.equal(computed.confirmedDeliveredSet.has('l1'), true);
  assert.equal(computed.inferredDeliveredSet.has('l1'), false);
  assert.equal(computed.effectiveDeliveredSet.has('l1'), true);
});

test('mixed scenario produces expected effective delivery totals', () => {
  const computed = buildEffectiveDeliveredSets({
    sentLeadIds: ['l1', 'l2', 'l3'],
    confirmedDeliveredLeadIds: ['l1'],
    hardBouncedLeadIds: ['l3'],
    softBouncedLeadIds: [],
  });
  assert.equal(computed.confirmedDeliveredSet.size, 1);
  assert.equal(computed.inferredDeliveredSet.size, 1);
  assert.equal(computed.effectiveDeliveredSet.size, 2);
});

test('delivery invariant promotes sent+open lead to delivered when webhook delivery is missing', () => {
  const base = buildEffectiveDeliveredSets({
    sentLeadIds: ['l1'],
    confirmedDeliveredLeadIds: [],
    hardBouncedLeadIds: [],
    softBouncedLeadIds: [],
  });
  const resolved = applyDeliveredEvidenceInvariant({
    sentLeadIds: ['l1'],
    effectiveDeliveredLeadIds: [],
    openedLeadIds: ['l1'],
    repliedLeadIds: [],
    bouncedLeadIds: [...base.bouncedSet],
  });
  assert.equal(resolved.effectiveDeliveredSet.has('l1'), true);
  assert.equal(resolved.promotedByOpenOrReplySet.has('l1'), true);
  assert.equal(resolved.deliveryInvariantApplied, true);
});

test('delivery invariant promotes sent+reply lead to delivered when webhook delivery is missing', () => {
  const base = buildEffectiveDeliveredSets({
    sentLeadIds: ['l1'],
    confirmedDeliveredLeadIds: [],
    hardBouncedLeadIds: [],
    softBouncedLeadIds: [],
  });
  const resolved = applyDeliveredEvidenceInvariant({
    sentLeadIds: ['l1'],
    effectiveDeliveredLeadIds: [],
    openedLeadIds: [],
    repliedLeadIds: ['l1'],
    bouncedLeadIds: [...base.bouncedSet],
  });
  assert.equal(resolved.effectiveDeliveredSet.has('l1'), true);
  assert.equal(resolved.promotedByOpenOrReplySet.has('l1'), true);
  assert.equal(resolved.deliveryInvariantApplied, true);
});

test('delivery invariant respects bounce precedence and never promotes bounced lead', () => {
  const base = buildEffectiveDeliveredSets({
    sentLeadIds: ['l1', 'l2'],
    confirmedDeliveredLeadIds: [],
    hardBouncedLeadIds: ['l1'],
    softBouncedLeadIds: [],
  });
  const resolved = applyDeliveredEvidenceInvariant({
    sentLeadIds: ['l1', 'l2'],
    effectiveDeliveredLeadIds: ['l2'],
    openedLeadIds: ['l1'],
    repliedLeadIds: [],
    bouncedLeadIds: [...base.bouncedSet],
  });
  assert.equal(resolved.effectiveDeliveredSet.has('l1'), false);
  assert.equal(resolved.promotedByOpenOrReplySet.has('l1'), false);
});

test('pending outcome math remains consistent after delivery invariant', () => {
  const sentLeadIds = ['l1', 'l2', 'l3'];
  const base = buildEffectiveDeliveredSets({
    sentLeadIds,
    confirmedDeliveredLeadIds: [],
    hardBouncedLeadIds: ['l3'],
    softBouncedLeadIds: [],
  });
  const resolved = applyDeliveredEvidenceInvariant({
    sentLeadIds,
    effectiveDeliveredLeadIds: [...base.effectiveDeliveredSet],
    openedLeadIds: ['l1'],
    repliedLeadIds: [],
    bouncedLeadIds: [...base.bouncedSet],
  });
  const sent = sentLeadIds.length;
  const delivered = resolved.effectiveDeliveredSet.size;
  const bouncedTotal = base.bouncedSet.size;
  const pendingOutcome = Math.max(sent - delivered - bouncedTotal, 0);
  assert.equal(pendingOutcome, 0);
});

test('hybrid reply counts combine strict and inferred without double count', () => {
  const computed = buildEffectiveReplyCounts({
    sentLeadIds: ['c1', 'c2', 'c3'],
    strictReplyLeadIds: ['c1', 'c2'],
    inferredReplyLeadIds: ['c2', 'c3'],
  });
  assert.equal(computed.strictCount, 2);
  assert.equal(computed.inferredOnlyCount, 1);
  assert.equal(computed.effectiveCount, 3);
});

test('hybrid reply counts ignore unsent leads', () => {
  const computed = buildEffectiveReplyCounts({
    sentLeadIds: ['c1'],
    strictReplyLeadIds: ['c1', 'c2'],
    inferredReplyLeadIds: ['c2', 'c3'],
  });
  assert.equal(computed.strictCount, 1);
  assert.equal(computed.inferredOnlyCount, 0);
  assert.equal(computed.effectiveCount, 1);
});
