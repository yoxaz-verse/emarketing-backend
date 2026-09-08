import test from 'node:test';
import assert from 'node:assert/strict';
import {
  makeIndustryOpportunityDedupeHash,
  normalizeIndustrySourceErrorMessage,
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

test('industry source fetch errors are translated into actionable messages', () => {
  const details = normalizeIndustrySourceErrorMessage('source_fetch_403');
  assert.equal(details.error_code, 'source_fetch_403');
  assert.equal(details.http_status, 403);
  assert.match(details.error_message, /blocked access/i);
  assert.match(details.suggested_action, /RSS\/API URL/i);
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

test('industry RSS parser separates funding news from opportunities', () => {
  const items = parseIndustryRssItems(`
    <rss><channel>
      <item>
        <title><![CDATA[Indian agri-tech startup raises seed funding]]></title>
        <link>https://inc42.com/funding/agritech-seed</link>
        <description><![CDATA[India based agri startup raised seed funding from investors.]]></description>
        <pubDate>Mon, 13 Jul 2026 10:00:00 GMT</pubDate>
      </item>
      <item>
        <title><![CDATA[Applications open for agri-tech seed accelerator]]></title>
        <link>https://inc42.com/startups/agritech-accelerator</link>
        <description><![CDATA[Indian agri startups can apply before the deadline for investor access.]]></description>
        <pubDate>Tue, 14 Jul 2026 10:00:00 GMT</pubDate>
      </item>
      <item>
        <title>Generic entertainment update</title>
        <link>https://example.com/entertainment</link>
        <description>Unrelated item</description>
      </item>
    </channel></rss>
  `, source);

  assert.equal(items.length, 2);
  assert.equal(items[0].category, 'funding_news');
  assert.equal(items[0].intelligence_type, 'funding_news');
  assert.equal(items[0].useful_for_funding, false);
  assert.equal(items[0].source_url, 'https://inc42.com/funding/agritech-seed');
  assert.equal(items[0].geography, 'India');
  assert.equal(items[1].category, 'accelerator');
  assert.equal(items[1].intelligence_type, 'opportunity');
  assert.equal(items[1].useful_for_funding, true);
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
