import test from 'node:test';
import assert from 'node:assert/strict';
import {
  makeIndustryOpportunityDedupeHash,
  normalizeIndustrySourceUrl,
} from '../industry-intelligence/industryIntelligence.service.js';

test('industry source URL normalization removes fragments and trailing slashes', () => {
  assert.equal(
    normalizeIndustrySourceUrl('https://Example.com/Funding/?b=2&a=1#section'),
    'https://example.com/funding/?a=1&b=2'
  );
  assert.equal(normalizeIndustrySourceUrl('https://example.com/path/'), 'https://example.com/path');
  assert.equal(normalizeIndustrySourceUrl(''), null);
});

test('industry opportunity dedupe prefers normalized source URL', () => {
  const first = makeIndustryOpportunityDedupeHash('inc42', {
    title: 'Different title',
    source_url: 'https://example.com/funding/?b=2&a=1#top',
  });
  const second = makeIndustryOpportunityDedupeHash('yourstory', {
    title: 'Another title',
    source_url: 'https://example.com/funding/?a=1&b=2',
  });

  assert.equal(first, second);
});

test('industry opportunity dedupe falls back to title source date and category', () => {
  const first = makeIndustryOpportunityDedupeHash('startupindia', {
    title: 'AgriTech Seed Pitch',
    category: 'pitch_event',
    opportunity_date: '2026-07-12',
  });
  const second = makeIndustryOpportunityDedupeHash('startupindia', {
    title: '  agritech seed pitch ',
    category: 'pitch_event',
    opportunity_date: '2026-07-12',
  });
  const third = makeIndustryOpportunityDedupeHash('inc42', {
    title: 'AgriTech Seed Pitch',
    category: 'pitch_event',
    opportunity_date: '2026-07-12',
  });

  assert.equal(first, second);
  assert.notEqual(first, third);
});
