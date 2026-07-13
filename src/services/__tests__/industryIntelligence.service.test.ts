import test from 'node:test';
import assert from 'node:assert/strict';
import {
  makeIndustryOpportunityDedupeHash,
  normalizeIndustrySourceUrl,
  parseIndustryHtmlItems,
  parseIndustryRssItems,
} from '../industry-intelligence/industryIntelligence.service.js';

const source = {
  code: 'inc42',
  name: 'Inc42 Funding & Accelerators',
  region: 'India',
  sector_focus: ['startup', 'funding'],
};

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

test('industry RSS parser extracts relevant funding items', () => {
  const items = parseIndustryRssItems(`
    <rss><channel>
      <item>
        <title><![CDATA[Indian agri-tech startup raises seed funding]]></title>
        <link>https://inc42.com/funding/agritech-seed</link>
        <description><![CDATA[India based agri startup raised seed funding from investors.]]></description>
        <pubDate>Mon, 13 Jul 2026 10:00:00 GMT</pubDate>
      </item>
      <item>
        <title>Generic entertainment update</title>
        <link>https://example.com/entertainment</link>
        <description>Unrelated item</description>
      </item>
    </channel></rss>
  `, source);

  assert.equal(items.length, 1);
  assert.equal(items[0].category, 'seed_funding');
  assert.equal(items[0].source_url, 'https://inc42.com/funding/agritech-seed');
  assert.equal(items[0].geography, 'India');
});

test('industry HTML parser extracts relevant opportunity links', () => {
  const items = parseIndustryHtmlItems(`
    <html><body>
      <a href="/programs/agritech-grant">India agri-tech startup grant scheme for seed founders</a>
      <a href="/about">About us</a>
    </body></html>
  `, 'https://startupindia.gov.in/schemes', {
    ...source,
    code: 'startupindia',
    name: 'Startup India',
  });

  assert.equal(items.length, 1);
  assert.equal(items[0].category, 'grant');
  assert.equal(items[0].source_url, 'https://startupindia.gov.in/programs/agritech-grant');
});
