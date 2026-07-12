import test from 'node:test';
import assert from 'node:assert/strict';

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

test('buildCountdownMeta labels future events', async () => {
  const { buildCountdownMeta } = await loadEventsModule();
  const meta = buildCountdownMeta('2026-07-15T00:00:00.000Z', new Date('2026-07-12T00:00:00.000Z'));

  assert.equal(meta.days_until, 3);
  assert.equal(meta.label, '3 days');
});
