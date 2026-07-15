import crypto from 'crypto';
import { supabase } from '../supabase';
import { safeFetch } from '../utils/safeFetch';

export type EventProviderType = 'rss' | 'ics' | 'api' | 'html';
export type EventScope = 'international' | 'india' | 'kerala' | 'district';
export type EventStatus = 'discovered' | 'planned' | 'ignored' | 'expired';

type EventSourceInput = {
  source_name: string;
  provider_type: EventProviderType;
  source_url: string;
  geography_scope?: EventScope;
  country?: string | null;
  state?: string | null;
  district?: string | null;
  categories?: string[];
  parser_key?: string | null;
  trust_score?: number;
  polling_interval_minutes?: number;
  active?: boolean;
};

type EventListFilters = {
  scope?: string | null;
  country?: string | null;
  state?: string | null;
  district?: string | null;
  category?: string | null;
  source_id?: string | null;
  status?: string | null;
  days?: number | string | null;
  page?: number | string | null;
  page_size?: number | string | null;
};

export type ParsedEventItem = {
  external_id?: string | null;
  title: string;
  description?: string | null;
  starts_at: string;
  ends_at?: string | null;
  timezone?: string | null;
  location?: string | null;
  category?: string | null;
  source_url?: string | null;
  source_snapshot?: Record<string, unknown>;
};

const SCOPES: EventScope[] = ['international', 'india', 'kerala', 'district'];
const PROVIDERS: EventProviderType[] = ['rss', 'ics', 'api', 'html'];
const STATUSES: EventStatus[] = ['discovered', 'planned', 'ignored', 'expired'];
const MONTHS: Record<string, number> = {
  jan: 0,
  january: 0,
  feb: 1,
  february: 1,
  mar: 2,
  march: 2,
  apr: 3,
  april: 3,
  may: 4,
  jun: 5,
  june: 5,
  jul: 6,
  july: 6,
  aug: 7,
  august: 7,
  sep: 8,
  sept: 8,
  september: 8,
  oct: 9,
  october: 9,
  nov: 10,
  november: 10,
  dec: 11,
  december: 11,
};

function cleanCdata(input: string): string {
  return decodeXml(input.replace(/<!\[CDATA\[|\]\]>/g, '').trim());
}

function decodeXml(input: string): string {
  return input
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

function stripHtml(input: string): string {
  return decodeXml(input.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim());
}

function htmlAttr(input: string, name: string): string {
  const match = input.match(new RegExp(`${name}\\s*=\\s*["']([^"']+)["']`, 'i'));
  return match?.[1] ? decodeXml(match[1].trim()) : '';
}

function normalizeString(value: unknown): string {
  return String(value ?? '').trim();
}

function normalizeNullable(value: unknown): string | null {
  const normalized = normalizeString(value);
  return normalized || null;
}

function normalizeScope(value: unknown): EventScope {
  const normalized = normalizeString(value).toLowerCase();
  return SCOPES.includes(normalized as EventScope) ? normalized as EventScope : 'international';
}

function normalizeProvider(value: unknown): EventProviderType {
  const normalized = normalizeString(value).toLowerCase();
  if (!PROVIDERS.includes(normalized as EventProviderType)) throw new Error('provider_type must be rss, ics, api, or html');
  return normalized as EventProviderType;
}

function normalizeCategories(input: unknown): string[] {
  const values = Array.isArray(input) ? input : [];
  return Array.from(new Set(values.map((v) => normalizeString(v)).filter(Boolean))).slice(0, 20);
}

function parseIsoDate(value: unknown, field: string): string {
  const raw = normalizeString(value);
  if (!raw) throw new Error(`${field} is required`);
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) throw new Error(`${field} must be a valid date-time`);
  return date.toISOString();
}

function parseOptionalIsoDate(value: unknown): string | null {
  const raw = normalizeString(value);
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function absoluteUrl(url: string | null | undefined, baseUrl?: string | null): string | null {
  const raw = normalizeString(url);
  if (!raw) return null;
  try {
    return new URL(raw, normalizeString(baseUrl) || undefined).toString();
  } catch {
    return raw;
  }
}

function dateFromParts(year: number, month: number, day: number): string | null {
  const date = new Date(Date.UTC(year, month, day, 9, 0, 0));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function parseHumanEventDate(input: string, now = new Date()): string | null {
  const text = normalizeString(input)
    .replace(/(\d)(?:st|nd|rd|th)\b/gi, '$1')
    .replace(/\s+/g, ' ');
  if (!text) return null;

  const isoToken = text.match(/\d{4}-\d{2}-\d{2}(?:[T\s]\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2})?)?/)?.[0];
  const iso = isoToken ? parseOptionalIsoDate(isoToken) : null;
  if (iso) return iso;

  const numeric = text.match(/\b(\d{1,2})[./-](\d{1,2})[./-](20\d{2})\b/);
  if (numeric) return dateFromParts(Number(numeric[3]), Number(numeric[2]) - 1, Number(numeric[1]));

  const dayMonthYear = text.match(/\b(\d{1,2})(?:\s*(?:-|to|&)\s*\d{1,2})?\s+([A-Za-z]{3,9}),?\s+(20\d{2})\b/i);
  if (dayMonthYear) {
    const month = MONTHS[dayMonthYear[2].toLowerCase()];
    if (month !== undefined) return dateFromParts(Number(dayMonthYear[3]), month, Number(dayMonthYear[1]));
  }

  const monthDayYear = text.match(/\b([A-Za-z]{3,9})\s+(\d{1,2})(?:\s*(?:-|to|&)\s*\d{1,2})?,?\s+(20\d{2})\b/i);
  if (monthDayYear) {
    const month = MONTHS[monthDayYear[1].toLowerCase()];
    if (month !== undefined) return dateFromParts(Number(monthDayYear[3]), month, Number(monthDayYear[2]));
  }

  const dayMonthNoYear = text.match(/\b(\d{1,2})(?:\s*(?:-|to|&)\s*\d{1,2})?\s+([A-Za-z]{3,9})\b/i);
  if (dayMonthNoYear) {
    const month = MONTHS[dayMonthNoYear[2].toLowerCase()];
    if (month !== undefined) {
      const year = month < now.getUTCMonth() - 1 ? now.getUTCFullYear() + 1 : now.getUTCFullYear();
      return dateFromParts(year, month, Number(dayMonthNoYear[1]));
    }
  }

  return null;
}

function findHtmlDate(blockText: string): string | null {
  const labelled = blockText.match(/\b(?:date|dates|event date|from|deadline|last date|application deadline)\s*[:\-]\s*([^|•\n]{4,80})/i)?.[1];
  return parseHumanEventDate(labelled ?? blockText);
}

function findHtmlLocation(blockText: string): string | null {
  const match = blockText.match(/\b(?:venue|location|place|city)\s*[:\-]\s*([^|•\n]{2,120})/i);
  return normalizeNullable(match?.[1]?.replace(/\b(?:date|event date)\b.*$/i, ''));
}

function htmlCellTexts(block: string): string[] {
  return Array.from(block.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi))
    .map((match) => stripHtml(match[1] ?? ''))
    .filter(Boolean);
}

function looksLikeEventDate(value: string): boolean {
  return (
    /\b\d{1,2}(?:st|nd|rd|th)?\s*(?:-|to|&)?\s*\d{0,2}\s*(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\b/i.test(value) ||
    /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\s+\d{1,2}/i.test(value) ||
    /\b\d{1,2}[./-]\d{1,2}[./-]20\d{2}\b/.test(value) ||
    /\b20\d{2}-\d{2}-\d{2}\b/.test(value)
  ) && Boolean(parseHumanEventDate(value));
}

function findHtmlTitle(block: string, blockText: string): string {
  const heading = block.match(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/i)?.[1];
  if (heading) return stripHtml(heading).slice(0, 300);
  const titleAttr = htmlAttr(block, 'title');
  if (titleAttr) return titleAttr.slice(0, 300);
  const cells = htmlCellTexts(block);
  const cellTitle = cells.find((cell) => !looksLikeEventDate(cell) && !/^(sr\.?no|date|venue|location|month|officer)\b/i.test(cell));
  if (cellTitle) return cellTitle.slice(0, 300);
  const lines = blockText.split(/\s{2,}|\n/).map((line) => line.trim()).filter(Boolean);
  return (lines.find((line) => !/^(date|venue|location|read more)\b/i.test(line)) ?? blockText).slice(0, 300);
}

function findHtmlLocationFromCells(block: string, blockText: string, title: string): string | null {
  const labelled = findHtmlLocation(blockText);
  if (labelled) return labelled;
  const cells = htmlCellTexts(block);
  return normalizeNullable(cells.find((cell) => {
    const lower = cell.toLowerCase();
    return cell !== title && !looksLikeEventDate(cell) && !/^(sr\.?no|date|month|officer|circular)\b/i.test(cell) && /,|india|uae|singapore|delhi|mumbai|bengaluru|bangalore|kochi|hyderabad|chennai|pune|dubai/i.test(lower);
  }));
}

function findHtmlSourceUrl(block: string, baseUrl?: string | null): string | null {
  const linkBlock = block.match(/<a\b[\s\S]*?<\/a>/i)?.[0] ?? block;
  const href = htmlAttr(linkBlock, 'href');
  return absoluteUrl(href, baseUrl);
}

function htmlBlocksForParser(html: string, parserKey: string): string[] {
  const normalizedKey = parserKey.toLowerCase();
  const classHints: Record<string, string[]> = {
    tpci_forthcoming_events: ['event', 'post', 'card', 'col'],
    apeda_trade_fairs: ['event', 'trade', 'fair', 'exhibition', 'row'],
    spices_board_trade_fairs: ['event', 'trade', 'fair', 'views-row', 'row'],
    ksum_events: ['event', 'card', 'views-row', 'row'],
    indiaai_events: ['event', 'hybrid', 'online', 'offline', 'card', 'row'],
    startup_india_challenges: ['challenge', 'program', 'initiative', 'event', 'card', 'row'],
    karnataka_startup_events: ['event', 'startup', 'elevate', 'challenge', 'program', 'row'],
    cii_events: ['event', 'conference', 'summit', 'webinar', 'training', 'row'],
    agri_trade_events: ['event', 'agri', 'agriculture', 'trade', 'expo', 'fair', 'row'],
    itpo_aahar_events: ['event', 'fair', 'exhibition', 'aahar', 'row'],
    cepci_events: ['event', 'fair', 'news', 'row'],
    ipga_events: ['event', 'conference', 'row', 'post'],
  };
  const hints = classHints[normalizedKey] ?? ['event', 'trade', 'fair', 'card', 'row', 'post'];
  const blocks: string[] = [];
  const elementRegex = /<(article|li|tr|div|section)\b[^>]*>[\s\S]*?<\/\1>/gi;
  for (const match of html.matchAll(elementRegex)) {
    const block = match[0] ?? '';
    const className = htmlAttr(block.slice(0, 500), 'class').toLowerCase();
    const text = stripHtml(block);
    if (text.length < 12) continue;
    if (hints.some((hint) => className.includes(hint) || text.toLowerCase().includes(hint))) {
      blocks.push(block);
    }
  }
  if (blocks.length === 0 && jsonLdBlocks(html).length > 0) return [];
  return blocks.length > 0 ? blocks : [html];
}

function jsonLdBlocks(html: string): unknown[] {
  const values: unknown[] = [];
  for (const match of html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    const raw = stripHtml(match[1] ?? '').trim();
    if (!raw) continue;
    try {
      values.push(JSON.parse(raw));
    } catch {
      continue;
    }
  }
  return values;
}

function collectJsonLdEvents(value: unknown, events: any[] = []): any[] {
  if (!value) return events;
  if (Array.isArray(value)) {
    for (const item of value) collectJsonLdEvents(item, events);
    return events;
  }
  if (typeof value !== 'object') return events;
  const row = value as Record<string, unknown>;
  const type = row['@type'];
  const types = Array.isArray(type) ? type.map((item) => String(item).toLowerCase()) : [String(type ?? '').toLowerCase()];
  if (types.includes('event')) events.push(row);
  collectJsonLdEvents(row['@graph'], events);
  return events;
}

function jsonLdLocationName(location: unknown): string | null {
  if (!location) return null;
  if (typeof location === 'string') return normalizeNullable(location);
  if (typeof location !== 'object') return null;
  const row = location as Record<string, any>;
  const address = row.address;
  const addressText = typeof address === 'string'
    ? address
    : address && typeof address === 'object'
      ? [address.streetAddress, address.addressLocality, address.addressRegion, address.addressCountry].map(normalizeString).filter(Boolean).join(', ')
      : '';
  return normalizeNullable([row.name, addressText].map(normalizeString).filter(Boolean).join(', '));
}

function parseJsonLdEventItems(html: string, source: { source_url?: string | null; categories?: string[] | null }): ParsedEventItem[] {
  return jsonLdBlocks(html)
    .flatMap((block) => collectJsonLdEvents(block))
    .map((event) => {
      const title = normalizeString(event.name ?? event.headline ?? event.title);
      const startsAt = parseOptionalIsoDate(event.startDate ?? event.start_date ?? event.date) ?? parseHumanEventDate(normalizeString(event.startDate ?? event.date));
      if (!title || !startsAt) return null;
      const url = absoluteUrl(normalizeString(event.url ?? event['@id']), source.source_url) ?? normalizeNullable(source.source_url);
      return {
        external_id: normalizeNullable(event['@id'] ?? event.identifier ?? url),
        title: title.slice(0, 300),
        description: stripHtml(normalizeString(event.description)).slice(0, 5000) || null,
        starts_at: startsAt,
        ends_at: parseOptionalIsoDate(event.endDate ?? event.end_date),
        timezone: 'Asia/Kolkata',
        location: jsonLdLocationName(event.location),
        category: Array.isArray(source.categories) ? source.categories[0] ?? null : null,
        source_url: url,
        source_snapshot: { parser: 'json_ld' },
      } satisfies ParsedEventItem;
    })
    .filter(Boolean) as ParsedEventItem[];
}

export function parseHtmlEventItems(html: string, source: { source_url?: string | null; parser_key?: string | null; categories?: string[] | null }): ParsedEventItem[] {
  const parserKey = normalizeString(source.parser_key) || 'generic_html_events';
  const items: ParsedEventItem[] = [];
  const seen = new Set<string>();
  const pushUnique = (item: ParsedEventItem) => {
    const key = `${item.title.toLowerCase()}|${item.starts_at}|${item.source_url ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    items.push(item);
  };

  for (const item of parseJsonLdEventItems(html, source)) {
    pushUnique({
      ...item,
      source_snapshot: { ...(item.source_snapshot ?? {}), parser_key: parserKey },
    });
  }

  for (const block of htmlBlocksForParser(html, parserKey)) {
    const blockText = stripHtml(block);
    const startsAt = findHtmlDate(blockText);
    if (!startsAt) continue;

    const sourceUrl = findHtmlSourceUrl(block, source.source_url) ?? normalizeNullable(source.source_url);
    const title = findHtmlTitle(block, blockText);
    if (!title || /^\d{1,2}\s+[A-Za-z]{3,9}/.test(title)) continue;

    pushUnique({
      external_id: sourceUrl ?? `${title.toLowerCase()}|${startsAt}`,
      title,
      description: blockText.slice(0, 5000) || null,
      starts_at: startsAt,
      ends_at: null,
      timezone: 'Asia/Kolkata',
      location: findHtmlLocationFromCells(block, blockText, title),
      category: Array.isArray(source.categories) ? source.categories[0] ?? null : null,
      source_url: sourceUrl,
      source_snapshot: { parser: 'html', parser_key: parserKey },
    });
  }

  return items;
}

function xmlTag(input: string, names: string[]): string {
  for (const name of names) {
    const match = input.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'i'));
    if (match?.[1]) return cleanCdata(match[1]);
  }
  return '';
}

function rssItemBlocks(xml: string): string[] {
  const matches = Array.from(xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi));
  if (matches.length > 0) return matches.map((match) => match[1] ?? '');
  return Array.from(xml.matchAll(/<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/gi)).map((match) => match[1] ?? '');
}

function rssLink(item: string): string {
  const link = xmlTag(item, ['link']);
  if (link) return link;
  const href = item.match(/<link[^>]+href=["']([^"']+)["']/i)?.[1];
  return href ? cleanCdata(href) : '';
}

function findRssStartDate(item: string): string | null {
  const candidates = [
    xmlTag(item, ['startDate', 'eventDate', 'dtstart', 'xCalStart', 'x-calstart', 'published', 'pubDate']),
    item.match(/(?:start|event)\s*date\s*[:\-]\s*([A-Z][a-z]{2,9}\s+\d{1,2},?\s+\d{4}(?:\s+\d{1,2}:\d{2}\s*(?:AM|PM)?)?)/i)?.[1] ?? '',
    item.match(/(\d{4}-\d{2}-\d{2}(?:[T\s]\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2})?)?)/)?.[1] ?? '',
  ];

  for (const candidate of candidates) {
    const parsed = parseOptionalIsoDate(candidate);
    if (parsed) return parsed;
  }
  return null;
}

export function parseRssEventItems(xml: string): ParsedEventItem[] {
  const items: ParsedEventItem[] = [];
  for (const item of rssItemBlocks(xml)) {
    const title = xmlTag(item, ['title']);
    if (!title) continue;
    const startsAt = findRssStartDate(item);
    if (!startsAt) continue;
    const description = stripHtml(xmlTag(item, ['description', 'summary', 'content:encoded', 'content'])).slice(0, 5000);
    const sourceUrl = rssLink(item);
    items.push({
      external_id: xmlTag(item, ['guid', 'id']) || sourceUrl || null,
      title: title.slice(0, 300),
      description: description || null,
      starts_at: startsAt,
      ends_at: parseOptionalIsoDate(xmlTag(item, ['endDate', 'dtend', 'xCalEnd', 'x-calend'])),
      timezone: xmlTag(item, ['timezone']) || 'UTC',
      location: xmlTag(item, ['location', 'venue']) || null,
      category: xmlTag(item, ['category']) || null,
      source_url: sourceUrl || null,
      source_snapshot: { parser: 'rss' },
    });
  }
  return items;
}

function unfoldIcs(input: string): string[] {
  return input.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n[ \t]/g, '').split('\n');
}

function parseIcsDate(raw: string): string | null {
  const value = normalizeString(raw);
  if (!value) return null;
  const iso = parseOptionalIsoDate(value);
  if (iso) return iso;
  const match = value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/);
  if (!match) return null;
  const [, y, mo, d, h = '00', mi = '00', s = '00', z] = match;
  const date = z
    ? new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}Z`)
    : new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function unescapeIcs(input: string): string {
  return input
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\')
    .trim();
}

function icsValue(line: string): { key: string; value: string; timezone: string | null } | null {
  const index = line.indexOf(':');
  if (index < 0) return null;
  const left = line.slice(0, index);
  const value = unescapeIcs(line.slice(index + 1));
  const [keyRaw, ...params] = left.split(';');
  const timezone = params.map((p) => p.split('=')).find(([key]) => key.toUpperCase() === 'TZID')?.[1] ?? null;
  return { key: keyRaw.toUpperCase(), value, timezone };
}

export function parseIcsEventItems(ics: string): ParsedEventItem[] {
  const lines = unfoldIcs(ics);
  const events: ParsedEventItem[] = [];
  let current: Record<string, string> | null = null;
  let timezone: string | null = null;

  for (const line of lines) {
    if (line.trim().toUpperCase() === 'BEGIN:VEVENT') {
      current = {};
      timezone = null;
      continue;
    }
    if (line.trim().toUpperCase() === 'END:VEVENT') {
      if (current?.SUMMARY && current.DTSTART) {
        const startsAt = parseIcsDate(current.DTSTART);
        if (startsAt) {
          events.push({
            external_id: current.UID ?? null,
            title: current.SUMMARY.slice(0, 300),
            description: current.DESCRIPTION?.slice(0, 5000) ?? null,
            starts_at: startsAt,
            ends_at: parseIcsDate(current.DTEND ?? ''),
            timezone: timezone || 'UTC',
            location: current.LOCATION ?? null,
            category: current.CATEGORIES?.split(',').map((v) => v.trim()).filter(Boolean)[0] ?? null,
            source_url: current.URL ?? null,
            source_snapshot: { parser: 'ics', uid: current.UID ?? null },
          });
        }
      }
      current = null;
      timezone = null;
      continue;
    }
    if (!current) continue;
    const parsed = icsValue(line);
    if (!parsed) continue;
    current[parsed.key] = parsed.value;
    if ((parsed.key === 'DTSTART' || parsed.key === 'DTEND') && parsed.timezone) timezone = parsed.timezone;
  }

  return events;
}

export function parseApiEventItems(raw: string): ParsedEventItem[] {
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('API source must return JSON');
  }

  const rows = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.events)
      ? parsed.events
      : Array.isArray(parsed?.items)
        ? parsed.items
        : Array.isArray(parsed?.results)
          ? parsed.results
          : [];

  return rows.map((row: any) => {
    const startsAt = parseOptionalIsoDate(row.starts_at ?? row.start_at ?? row.startDate ?? row.date ?? row.datetime);
    const title = normalizeString(row.title ?? row.name ?? row.summary);
    if (!title || !startsAt) return null;
    return {
      external_id: normalizeNullable(row.id ?? row.uid ?? row.external_id),
      title: title.slice(0, 300),
      description: normalizeNullable(row.description ?? row.body ?? row.summary),
      starts_at: startsAt,
      ends_at: parseOptionalIsoDate(row.ends_at ?? row.end_at ?? row.endDate),
      timezone: normalizeNullable(row.timezone) ?? 'UTC',
      location: normalizeNullable(row.location ?? row.venue),
      category: normalizeNullable(row.category ?? row.type),
      source_url: normalizeNullable(row.source_url ?? row.url),
      source_snapshot: { parser: 'api' },
    } satisfies ParsedEventItem;
  }).filter(Boolean) as ParsedEventItem[];
}

export function dedupeHashForEvent(input: {
  sourceId?: string | null;
  sourceUrl?: string | null;
  title: string;
  startsAt: string;
  externalId?: string | null;
}): string {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({
      sourceId: input.sourceId ?? null,
      externalId: input.externalId ?? null,
      sourceUrl: input.sourceUrl ?? null,
      title: input.title.trim().toLowerCase(),
      startsAt: input.startsAt,
    }))
    .digest('hex');
}

function sourceEventPayload(source: any, item: ParsedEventItem, userId?: string | null) {
  const startsAt = parseIsoDate(item.starts_at, 'starts_at');
  const sourceUrl = item.source_url ?? source.source_url ?? null;
  return {
    source_id: source.id,
    title: item.title.trim(),
    description: item.description ?? null,
    starts_at: startsAt,
    ends_at: item.ends_at ? parseOptionalIsoDate(item.ends_at) : null,
    timezone: item.timezone ?? 'UTC',
    location: item.location ?? null,
    geography_scope: source.geography_scope,
    country: source.country ?? null,
    state: source.state ?? null,
    district: source.district ?? null,
    category: item.category ?? (Array.isArray(source.categories) ? source.categories[0] : null) ?? null,
    source_url: sourceUrl,
    source_snapshot: {
      ...(item.source_snapshot ?? {}),
      source_name: source.source_name,
      provider_type: source.provider_type,
      feed_url: source.source_url,
      external_id: item.external_id ?? null,
    },
    dedupe_hash: dedupeHashForEvent({
      sourceId: source.id,
      sourceUrl,
      title: item.title,
      startsAt,
      externalId: item.external_id ?? null,
    }),
    status: new Date(startsAt).getTime() < Date.now() ? 'expired' : 'discovered',
    countdown_meta: buildCountdownMeta(startsAt),
    created_by: userId ?? null,
    updated_by: userId ?? null,
  };
}

export function buildCountdownMeta(startsAt: string, now = new Date()) {
  const msUntil = new Date(startsAt).getTime() - now.getTime();
  const daysUntil = Math.ceil(msUntil / 86_400_000);
  return {
    ms_until: msUntil,
    days_until: daysUntil,
    label: msUntil <= 0 ? 'Started' : daysUntil <= 1 ? 'Today' : `${daysUntil} days`,
    computed_at: now.toISOString(),
  };
}

export async function listEventSources() {
  const { data, error } = await supabase
    .from('event_sources')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) {
    if (error.code === 'PGRST205') return [];
    throw error;
  }
  return data ?? [];
}

export async function createEventSource(input: EventSourceInput, userId?: string | null) {
  const sourceName = normalizeString(input.source_name);
  if (!sourceName) throw new Error('source_name is required');
  const providerType = normalizeProvider(input.provider_type);
  const sourceUrl = normalizeString(input.source_url);
  if (!sourceUrl) throw new Error('source_url is required');

  const payload = {
    source_name: sourceName,
    provider_type: providerType,
    source_url: sourceUrl,
    geography_scope: normalizeScope(input.geography_scope),
    country: normalizeNullable(input.country) ?? (normalizeScope(input.geography_scope) === 'international' ? null : 'India'),
    state: normalizeNullable(input.state),
    district: normalizeNullable(input.district),
    categories: normalizeCategories(input.categories),
    parser_key: normalizeNullable(input.parser_key),
    trust_score: Math.max(0, Math.min(1, Number(input.trust_score ?? 0.7) || 0.7)),
    polling_interval_minutes: Math.max(15, Math.trunc(Number(input.polling_interval_minutes ?? 360) || 360)),
    active: input.active !== false,
    created_by: userId ?? null,
  };

  const { data, error } = await supabase
    .from('event_sources')
    .insert(payload)
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

export async function listEvents(filters: EventListFilters) {
  await expirePastDiscoveredEvents();
  const safePage = Math.max(1, Math.trunc(Number(filters.page ?? 1) || 1));
  const safePageSize = Math.max(1, Math.min(100, Math.trunc(Number(filters.page_size ?? 50) || 50)));
  const days = Math.max(1, Math.min(365, Math.trunc(Number(filters.days ?? 30) || 30)));
  const until = new Date(Date.now() + days * 86_400_000).toISOString();

  let query = supabase
    .from('event_items')
    .select('*, event_sources(source_name, provider_type)', { count: 'exact' })
    .gte('starts_at', new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString())
    .lte('starts_at', until)
    .order('starts_at', { ascending: true });

  const scope = normalizeString(filters.scope).toLowerCase();
  if (SCOPES.includes(scope as EventScope)) query = query.eq('geography_scope', scope);
  if (normalizeString(filters.country)) query = query.ilike('country', `%${normalizeString(filters.country)}%`);
  if (normalizeString(filters.state)) query = query.ilike('state', `%${normalizeString(filters.state)}%`);
  if (normalizeString(filters.district)) query = query.ilike('district', `%${normalizeString(filters.district)}%`);
  if (normalizeString(filters.category)) query = query.ilike('category', `%${normalizeString(filters.category)}%`);
  if (normalizeString(filters.source_id)) query = query.eq('source_id', normalizeString(filters.source_id));
  const status = normalizeString(filters.status).toLowerCase();
  if (STATUSES.includes(status as EventStatus)) query = query.eq('status', status);
  else query = query.neq('status', 'ignored');

  const { data, error, count } = await query.range((safePage - 1) * safePageSize, safePage * safePageSize - 1);
  if (error) {
    if (error.code === 'PGRST205') return { rows: [], total: 0, page: safePage, page_size: safePageSize };
    throw error;
  }

  const now = new Date();
  return {
    rows: (data ?? []).map((row: any) => ({
      ...row,
      countdown_meta: buildCountdownMeta(row.starts_at, now),
    })),
    total: Number(count ?? 0),
    page: safePage,
    page_size: safePageSize,
  };
}

async function fetchSourceItems(source: any): Promise<ParsedEventItem[]> {
  const response = await safeFetch(String(source.source_url), {}, { timeoutMs: 20000 });
  if (!response.ok) throw new Error(`source_fetch_${response.status}`);
  const text = await response.text();
  if (source.provider_type === 'api') return parseApiEventItems(text);
  if (source.provider_type === 'ics') return parseIcsEventItems(text);
  if (source.provider_type === 'html') return parseHtmlEventItems(text, source);
  return parseRssEventItems(text);
}

export async function runEventIngestion(userId?: string | null) {
  await expirePastDiscoveredEvents();
  const { data: sources, error } = await supabase
    .from('event_sources')
    .select('*')
    .eq('active', true)
    .order('created_at', { ascending: true });
  if (error) throw error;

  const summary = {
    processed_sources: 0,
    processed_count: 0,
    inserted_count: 0,
    skipped_count: 0,
    error_count: 0,
    errors: [] as Array<{ source_id: string; message: string }>,
  };

  for (const source of sources ?? []) {
    const startedAt = new Date().toISOString();
    let processed = 0;
    let inserted = 0;
    let skipped = 0;
    const runErrors: Array<{ message: string }> = [];
    summary.processed_sources += 1;

    try {
      const items = await fetchSourceItems(source);
      for (const item of items) {
        processed += 1;
        summary.processed_count += 1;
        try {
          if (!normalizeString(item.title)) {
            skipped += 1;
            summary.skipped_count += 1;
            continue;
          }
          const payload = sourceEventPayload(source, item, userId);
          const { error: insertError } = await supabase.from('event_items').insert(payload);
          if (insertError) {
            if (String(insertError.code) === '23505' || String(insertError.message).toLowerCase().includes('duplicate')) {
              skipped += 1;
              summary.skipped_count += 1;
              continue;
            }
            throw insertError;
          }
          inserted += 1;
          summary.inserted_count += 1;
        } catch (itemError: any) {
          summary.error_count += 1;
          runErrors.push({ message: itemError?.message ?? 'item_error' });
        }
      }

      await supabase
        .from('event_sources')
        .update({ last_ingested_at: new Date().toISOString(), last_error: runErrors[0]?.message ?? null, updated_at: new Date().toISOString() })
        .eq('id', source.id);
    } catch (sourceError: any) {
      summary.error_count += 1;
      const message = sourceError?.message ?? 'source_error';
      summary.errors.push({ source_id: source.id, message });
      runErrors.push({ message });
      await supabase
        .from('event_sources')
        .update({ last_error: message, updated_at: new Date().toISOString() })
        .eq('id', source.id);
    } finally {
      const status = runErrors.length === 0 ? 'success' : inserted > 0 ? 'partial' : 'failed';
      await supabase.from('event_ingestion_runs').insert({
        source_id: source.id,
        status,
        processed_count: processed,
        inserted_count: inserted,
        skipped_count: skipped,
        error_count: runErrors.length,
        errors: runErrors,
        started_at: startedAt,
        finished_at: new Date().toISOString(),
        created_by: userId ?? null,
      });
    }
  }

  return summary;
}

export async function updateEventStatus(id: string, input: { status?: string; planning_notes?: string | null }, userId?: string | null) {
  const status = normalizeString(input.status).toLowerCase();
  if (!STATUSES.includes(status as EventStatus)) throw new Error('status must be discovered, planned, ignored, or expired');

  const payload: Record<string, unknown> = {
    status,
    updated_by: userId ?? null,
    updated_at: new Date().toISOString(),
  };
  if (Object.prototype.hasOwnProperty.call(input, 'planning_notes')) {
    payload.planning_notes = normalizeNullable(input.planning_notes);
  }

  const { data, error } = await supabase
    .from('event_items')
    .update(payload)
    .eq('id', id)
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

export async function expirePastDiscoveredEvents() {
  const { error } = await supabase
    .from('event_items')
    .update({ status: 'expired', updated_at: new Date().toISOString() })
    .lt('starts_at', new Date().toISOString())
    .eq('status', 'discovered');
  if (error && error.code !== 'PGRST205') throw error;
}
