import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role-key';

async function loadEventsModule() {
  return import('./events.service.js');
}

test('parseRssEventItems extracts upcoming RSS event fields', async () => {
  const { parseRssEventItems } = await loadEventsModule();
  const items = parseRssEventItems(`
    <rss><channel><item>
      <title><![CDATA[Kerala Export Summit]]></title>
      <description><![CDATA[<p>Buyer-seller event</p>]]></description>
      <link>https://example.com/events/export-summit</link>
      <guid>summit-1</guid>
      <startDate>2026-08-20T10:00:00+05:30</startDate>
      <endDate>2026-08-20T17:00:00+05:30</endDate>
      <location>Kochi</location>
      <category>business</category>
    </item></channel></rss>
  `);

  assert.equal(items.length, 1);
  assert.equal(items[0].title, 'Kerala Export Summit');
  assert.equal(items[0].location, 'Kochi');
  assert.equal(items[0].category, 'business');
  assert.match(items[0].description ?? '', /Buyer-seller event/);
  assert.equal(items[0].starts_at, '2026-08-20T04:30:00.000Z');
});

test('parseIcsEventItems extracts VEVENT fields and timezone', async () => {
  const { parseIcsEventItems } = await loadEventsModule();
  const items = parseIcsEventItems([
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT',
    'UID:onam-2026',
    'SUMMARY:Onam Campaign Window',
    'DESCRIPTION:Seasonal planning opportunity',
    'DTSTART;TZID=Asia/Kolkata:20260824T090000',
    'DTEND;TZID=Asia/Kolkata:20260824T120000',
    'LOCATION:Kerala',
    'CATEGORIES:festival,marketing',
    'URL:https://example.com/onam',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\n'));

  assert.equal(items.length, 1);
  assert.equal(items[0].external_id, 'onam-2026');
  assert.equal(items[0].title, 'Onam Campaign Window');
  assert.equal(items[0].timezone, 'Asia/Kolkata');
  assert.equal(items[0].category, 'festival');
});

test('dedupeHashForEvent is stable for equivalent input', async () => {
  const { dedupeHashForEvent } = await loadEventsModule();
  const first = dedupeHashForEvent({
    sourceId: 'source-1',
    sourceUrl: 'https://example.com/event',
    title: 'Trade Fair',
    startsAt: '2026-09-01T00:00:00.000Z',
    externalId: 'external-1',
  });
  const second = dedupeHashForEvent({
    sourceId: 'source-1',
    sourceUrl: 'https://example.com/event',
    title: ' trade fair ',
    startsAt: '2026-09-01T00:00:00.000Z',
    externalId: 'external-1',
  });

  assert.equal(first, second);
  assert.equal(first.length, 64);
});

test('parseApiEventItems accepts events arrays', async () => {
  const { parseApiEventItems } = await loadEventsModule();
  const items = parseApiEventItems(JSON.stringify({
    events: [
      {
        id: 'global-expo',
        name: 'Global Expo',
        startDate: '2026-10-05T09:00:00Z',
        venue: 'Dubai',
        url: 'https://example.com/global-expo',
      },
    ],
  }));

  assert.equal(items.length, 1);
  assert.equal(items[0].title, 'Global Expo');
  assert.equal(items[0].location, 'Dubai');
  assert.equal(items[0].starts_at, '2026-10-05T09:00:00.000Z');
});

test('parseHtmlEventItems handles TPCI-style event cards', async () => {
  const { parseHtmlEventItems } = await loadEventsModule();
  const items = parseHtmlEventItems(`
    <article class="event-card">
      <a href="/events/world-food-india"><h3>World Food India Buyer Seller Meet</h3></a>
      <p>Date: 16 - 20 September 2026</p>
      <p>Venue: New Delhi</p>
    </article>
  `, {
    source_url: 'https://www.tpci.in/forthcoming-events/',
    parser_key: 'tpci_forthcoming_events',
    categories: ['food export'],
  });

  assert.equal(items.length, 1);
  assert.equal(items[0].title, 'World Food India Buyer Seller Meet');
  assert.equal(items[0].location, 'New Delhi');
  assert.equal(items[0].category, 'food export');
  assert.equal(items[0].starts_at, '2026-09-16T09:00:00.000Z');
  assert.equal(items[0].source_url, 'https://www.tpci.in/events/world-food-india');
});

test('parseHtmlEventItems handles APEDA trade fair table rows', async () => {
  const { parseHtmlEventItems } = await loadEventsModule();
  const items = parseHtmlEventItems(`
    <table>
      <tr class="trade-fair-row">
        <td>Gulfood 2027</td>
        <td>Dubai, UAE</td>
        <td>10th - 12th April 2027</td>
      </tr>
    </table>
  `, {
    source_url: 'https://apeda.gov.in/TradeFairs',
    parser_key: 'apeda_trade_fairs',
    categories: ['food export'],
  });

  assert.equal(items.length, 1);
  assert.match(items[0].title, /Gulfood 2027/);
  assert.equal(items[0].starts_at, '2027-04-10T09:00:00.000Z');
});

test('parseHtmlEventItems handles Spices Board trade fair entries', async () => {
  const { parseHtmlEventItems } = await loadEventsModule();
  const items = parseHtmlEventItems(`
    <div class="views-row trade-fair">
      <h4>International Spice Conference</h4>
      <span>Date: February 20, 2027</span>
      <span>Location: Kochi</span>
    </div>
  `, {
    source_url: 'https://www.indianspices.com/marketing/trade/trade-fairs.html',
    parser_key: 'spices_board_trade_fairs',
    categories: ['spices'],
  });

  assert.equal(items.length, 1);
  assert.equal(items[0].title, 'International Spice Conference');
  assert.equal(items[0].location, 'Kochi');
  assert.equal(items[0].starts_at, '2027-02-20T09:00:00.000Z');
});

test('parseHtmlEventItems handles KSUM event cards', async () => {
  const { parseHtmlEventItems } = await loadEventsModule();
  const items = parseHtmlEventItems(`
    <section class="event">
      <a href="https://startupmission.kerala.gov.in/events/agritech-connect"><h2>AgriTech Connect Kerala</h2></a>
      <div>Date: 8 Aug 2026</div>
      <div>Venue: Kochi</div>
    </section>
  `, {
    source_url: 'https://startupmission.kerala.gov.in/events',
    parser_key: 'ksum_events',
    categories: ['agri'],
  });

  assert.equal(items.length, 1);
  assert.equal(items[0].title, 'AgriTech Connect Kerala');
  assert.equal(items[0].starts_at, '2026-08-08T09:00:00.000Z');
});

test('parseHtmlEventItems handles ITPO, CEPCI, and IPGA parser keys', async () => {
  const { parseHtmlEventItems } = await loadEventsModule();
  const parserKeys = ['itpo_aahar_events', 'cepci_events', 'ipga_events'];

  for (const parserKey of parserKeys) {
    const items = parseHtmlEventItems(`
      <div class="event post">
        <h3>${parserKey} Export Conclave</h3>
        <p>Date: 15 November 2026</p>
        <p>Location: Mumbai</p>
      </div>
    `, {
      source_url: 'https://example.com/events',
      parser_key: parserKey,
      categories: ['trade fair'],
    });

    assert.equal(items.length, 1);
    assert.match(items[0].title, /Export Conclave/);
    assert.equal(items[0].starts_at, '2026-11-15T09:00:00.000Z');
  }
});

test('predefined agri source migration is idempotent and unique by source_url', () => {
  const sql = readFileSync('sql/20260713_add_predefined_agri_event_sources.sql', 'utf8');
  const urls = Array.from(sql.matchAll(/'https:\/\/[^']+'/g)).map((match) => match[0]);

  assert.match(sql, /ADD COLUMN IF NOT EXISTS parser_key/);
  assert.match(sql, /provider_type IN \('rss', 'ics', 'api', 'html'\)/);
  assert.match(sql, /WHERE NOT EXISTS/);
  assert.equal(new Set(urls).size, urls.length);
  assert.ok(urls.length >= 7);
});

test('buildCountdownMeta labels future events', async () => {
  const { buildCountdownMeta } = await loadEventsModule();
  const meta = buildCountdownMeta('2026-07-15T00:00:00.000Z', new Date('2026-07-12T00:00:00.000Z'));

  assert.equal(meta.days_until, 3);
  assert.equal(meta.label, '3 days');
});
