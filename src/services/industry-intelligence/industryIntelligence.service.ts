import crypto from 'crypto';
import XLSX from 'xlsx';
import { supabase } from '../../supabase';
import { safeFetch } from '../../utils/safeFetch';
import {
  IndustryFetchRun,
  IndustryIntelligenceSource,
  IndustryOpportunityCategory,
  IndustryOpportunityFilters,
  IndustryOpportunityInput,
  IndustryOpportunityPatch,
  IndustryOpportunityStatus,
  IndustrySourceMode,
} from './types';

const ALLOWED_CATEGORIES: IndustryOpportunityCategory[] = [
  'seed_funding',
  'grant',
  'accelerator',
  'pitch_event',
  'demo_day',
  'investor_call',
  'ecosystem_program',
];

const ALLOWED_STATUSES: IndustryOpportunityStatus[] = [
  'new',
  'reviewed',
  'shortlisted',
  'applied',
  'not_relevant',
  'closed',
];

const FALLBACK_SOURCES: IndustryIntelligenceSource[] = [
  fallbackSource('startupindia', 'Startup India', 'html', 'https://www.startupindia.gov.in/content/sih/en/government-schemes.html', ['startup', 'agri-tech', 'technology'], { priority: 1 }),
  fallbackSource('agri_uddaan', 'Agri Udaan / Agritech Programs', 'html', 'https://aidea.naarm.org.in/', ['agri-tech', 'food-tech'], { priority: 2 }),
  fallbackSource('nasscom', 'NASSCOM / DeepTech Programs', 'html', 'https://www.nasscom.in/what-we-do/innovation-startups', ['technology', 'deeptech'], { priority: 3 }),
  fallbackSource('yourstory', 'YourStory Funding News', 'rss', 'https://yourstory.com/feed', ['startup', 'funding'], { priority: 4 }),
  fallbackSource('inc42', 'Inc42 Funding & Accelerators', 'rss', 'https://inc42.com/feed/', ['startup', 'funding'], { priority: 5 }),
  fallbackSource('investindia', 'Invest India Programs', 'html', 'https://www.investindia.gov.in/schemes-for-startups', ['startup', 'agri-tech', 'export'], { priority: 6 }),
];

type SourceFetchMode = IndustrySourceMode | 'html';

type ParsedIndustryItem = IndustryOpportunityInput & {
  confidence?: number;
};

function fallbackSource(
  code: string,
  name: string,
  mode: SourceFetchMode,
  sourceUrl: string,
  sectorFocus: string[],
  metadata: Record<string, unknown>
): IndustryIntelligenceSource {
  return {
    id: `fallback-${code}`,
    code,
    name,
    mode: mode === 'html' ? 'api' : mode,
    status: 'active',
    region: 'India',
    sector_focus: sectorFocus,
    source_url: sourceUrl,
    supports_fetch: mode !== 'manual',
    supports_manual: true,
    auth_ready: false,
    health_status: 'fallback',
    metadata: { ...metadata, fallback: true, source_url: sourceUrl, parser: mode },
    last_checked_at: null,
    last_success_at: null,
    last_error: null,
    polling_interval_minutes: 360,
    created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(),
    source_origin: 'fallback',
  };
}

function isSchemaMissingError(err: any): boolean {
  const code = String(err?.code ?? '');
  const msg = String(err?.message ?? '').toLowerCase();
  return (
    code === '42P01' ||
    code === 'PGRST205' ||
    code === '42703' ||
    msg.includes('schema cache') ||
    msg.includes('could not find the table') ||
    msg.includes('does not exist')
  );
}

function normalizeText(value: unknown): string | null {
  const v = String(value ?? '').trim();
  return v.length > 0 ? v : null;
}

function decodeXml(input: string): string {
  return input
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

function cleanCdata(input: string): string {
  return decodeXml(input.replace(/<!\[CDATA\[|\]\]>/g, '').trim());
}

function stripHtml(input: string): string {
  return decodeXml(input.replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim());
}

function xmlTag(input: string, names: string[]): string {
  for (const name of names) {
    const match = input.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'i'));
    if (match?.[1]) return cleanCdata(match[1]);
  }
  return '';
}

function rssItemBlocks(xml: string): string[] {
  const itemMatches = Array.from(xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi));
  if (itemMatches.length > 0) return itemMatches.map((match) => match[1] ?? '');
  return Array.from(xml.matchAll(/<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/gi)).map((match) => match[1] ?? '');
}

function rssLink(item: string): string {
  const link = xmlTag(item, ['link']);
  if (link) return link;
  const href = item.match(/<link[^>]+href=["']([^"']+)["']/i)?.[1];
  return href ? cleanCdata(href) : '';
}

function parseOptionalDate(value: unknown): string | null {
  const raw = normalizeText(value);
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function normalizeAbsoluteUrl(raw: string, baseUrl: string): string | null {
  const value = normalizeText(raw);
  if (!value) return null;
  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return null;
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function todayKey(): string {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return `${yyyy}${mm}${dd}`;
}

export function normalizeIndustrySourceUrl(raw: unknown): string | null {
  const input = normalizeText(raw);
  if (!input) return null;

  try {
    const url = new URL(input);
    url.hash = '';
    url.searchParams.sort();
    const normalized = url.toString().replace(/\/$/, '');
    return normalized.toLowerCase();
  } catch {
    return input.replace(/\/$/, '').toLowerCase();
  }
}

function inferCategory(input: IndustryOpportunityInput): IndustryOpportunityCategory {
  const explicit = String(input.category ?? '').trim().toLowerCase();
  if (ALLOWED_CATEGORIES.includes(explicit as IndustryOpportunityCategory)) {
    return explicit as IndustryOpportunityCategory;
  }

  const haystack = `${input.title ?? ''} ${input.summary ?? ''}`.toLowerCase();
  if (haystack.includes('demo day')) return 'demo_day';
  if (haystack.includes('grant')) return 'grant';
  if (haystack.includes('scheme') || haystack.includes('subsidy')) return 'grant';
  if (haystack.includes('seed') || haystack.includes('funding') || haystack.includes('raises') || haystack.includes('raised') || haystack.includes('investment')) return 'seed_funding';
  if (haystack.includes('accelerator') || haystack.includes('incubator')) return 'accelerator';
  if (haystack.includes('pitch') || haystack.includes('startup showcase')) return 'pitch_event';
  if (haystack.includes('investor') || haystack.includes('vc') || haystack.includes('venture capital')) return 'investor_call';
  if (haystack.includes('program') || haystack.includes('challenge')) return 'ecosystem_program';
  return 'seed_funding';
}

function normalizeTags(input: string[] | string | null | undefined): string[] {
  if (Array.isArray(input)) {
    return input.map((x) => String(x).trim()).filter(Boolean).slice(0, 20);
  }
  return String(input ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(0, 20);
}

function normalizeScore(input: number | string | null | undefined): number | null {
  if (input === null || input === undefined || input === '') return null;
  const score = Number(input);
  if (!Number.isFinite(score)) return null;
  return Math.min(100, Math.max(0, Math.round(score)));
}

function relevanceFor(input: IndustryOpportunityInput): number {
  const haystack = `${input.title ?? ''} ${input.summary ?? ''} ${input.sector ?? ''}`.toLowerCase();
  let score = 45;
  if (haystack.includes('agri') || haystack.includes('farm') || haystack.includes('food')) score += 25;
  if (haystack.includes('india') || haystack.includes('bharat')) score += 10;
  if (haystack.includes('seed') || haystack.includes('grant') || haystack.includes('pitch')) score += 10;
  if (haystack.includes('startup') || haystack.includes('technology') || haystack.includes('tech')) score += 10;
  return Math.min(100, score);
}

function isRelevantIndustryItem(input: IndustryOpportunityInput): boolean {
  const itemText = `${input.title ?? ''} ${input.summary ?? ''}`.toLowerCase();
  const haystack = `${itemText} ${input.sector ?? ''} ${input.geography ?? ''}`.toLowerCase();
  const indiaSignals = ['india', 'indian', 'bharat', 'startup india', 'karnataka', 'maharashtra', 'telangana', 'kerala', 'tamil nadu', 'gujarat', 'delhi', 'bengaluru', 'mumbai', 'hyderabad'];
  const topicSignals = ['startup', 'funding', 'fund', 'grant', 'seed', 'accelerator', 'incubator', 'pitch', 'demo day', 'investor', 'venture', 'agri', 'farm', 'foodtech', 'deeptech', 'technology', 'scheme'];
  return indiaSignals.some((signal) => haystack.includes(signal)) && topicSignals.some((signal) => itemText.includes(signal));
}

export function parseIndustryRssItems(xml: string, source: Pick<IndustryIntelligenceSource, 'name' | 'code' | 'region' | 'sector_focus'>): ParsedIndustryItem[] {
  const items: ParsedIndustryItem[] = [];
  for (const item of rssItemBlocks(xml)) {
    const title = xmlTag(item, ['title']);
    if (!title) continue;
    const summary = stripHtml(xmlTag(item, ['description', 'summary', 'content:encoded', 'content'])).slice(0, 1600);
    const sourceUrl = rssLink(item);
    const publishedAt = parseOptionalDate(xmlTag(item, ['pubDate', 'published', 'updated', 'dc:date']));
    const category = inferCategory({ title, summary });
    const parsed: ParsedIndustryItem = {
      title: title.slice(0, 300),
      summary: summary || null,
      source_name: source.name,
      source_url: sourceUrl || null,
      category,
      sector: source.sector_focus?.[0] ?? null,
      geography: source.region ?? 'India',
      opportunity_date: publishedAt,
      organizer_or_investor: source.name,
      relevance_score: relevanceFor({ title, summary, sector: source.sector_focus?.[0] ?? null }),
      tags: [source.code, category, ...(source.sector_focus ?? [])].slice(0, 8),
      useful_for_funding: ['seed_funding', 'grant', 'accelerator', 'investor_call'].includes(category),
      useful_for_partnerships: ['accelerator', 'ecosystem_program', 'pitch_event', 'demo_day'].includes(category),
      useful_for_content: true,
      raw_payload: { parser: 'rss', guid: xmlTag(item, ['guid', 'id']) || null },
      confidence: sourceUrl ? 0.8 : 0.55,
    };
    if (isRelevantIndustryItem(parsed)) items.push(parsed);
  }
  return items;
}

export function parseIndustryHtmlItems(html: string, baseUrl: string, source: Pick<IndustryIntelligenceSource, 'name' | 'code' | 'region' | 'sector_focus'>): ParsedIndustryItem[] {
  const candidates = new Map<string, ParsedIndustryItem>();
  const anchorRegex = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(anchorRegex)) {
    const href = match[1] ?? '';
    const text = stripHtml(match[2] ?? '').slice(0, 300);
    if (!text || text.length < 12) continue;
    const sourceUrl = normalizeAbsoluteUrl(href, baseUrl);
    const category = inferCategory({ title: text, summary: text });
    const parsed: ParsedIndustryItem = {
      title: text,
      summary: text,
      source_name: source.name,
      source_url: sourceUrl,
      category,
      sector: source.sector_focus?.[0] ?? null,
      geography: source.region ?? 'India',
      opportunity_date: nowIso(),
      organizer_or_investor: source.name,
      relevance_score: relevanceFor({ title: text, summary: text, sector: source.sector_focus?.[0] ?? null }),
      tags: [source.code, category, ...(source.sector_focus ?? [])].slice(0, 8),
      useful_for_funding: ['seed_funding', 'grant', 'accelerator', 'investor_call'].includes(category),
      useful_for_partnerships: ['accelerator', 'ecosystem_program', 'pitch_event', 'demo_day'].includes(category),
      useful_for_content: true,
      raw_payload: { parser: 'html_anchor' },
      confidence: sourceUrl ? 0.55 : 0.35,
    };
    if (isRelevantIndustryItem(parsed)) {
      candidates.set(sourceUrl ?? `${source.code}:${text.toLowerCase()}`, parsed);
    }
  }

  return Array.from(candidates.values()).slice(0, 20);
}

export function makeIndustryOpportunityDedupeHash(sourceCode: string, input: IndustryOpportunityInput): string {
  const sourceUrl = normalizeIndustrySourceUrl(input.source_url);
  const parts = sourceUrl
    ? ['url', sourceUrl]
    : [
        'fallback',
        sourceCode,
        String(input.title ?? '').trim().toLowerCase(),
        String(input.opportunity_date ?? input.deadline_date ?? '').trim().toLowerCase(),
        String(input.category ?? '').trim().toLowerCase(),
      ];
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex');
}

function sourceUrlFor(source: IndustryIntelligenceSource): string | null {
  return normalizeText(source.source_url)
    ?? normalizeText(source.metadata?.feed_url)
    ?? normalizeText(source.metadata?.source_url)
    ?? normalizeText(source.metadata?.url);
}

function parserFor(source: IndustryIntelligenceSource): SourceFetchMode {
  const parser = String(source.metadata?.parser ?? '').toLowerCase();
  if (parser === 'html' || parser === 'rss' || parser === 'api' || parser === 'webhook' || parser === 'manual') return parser;
  return source.mode === 'rss' ? 'rss' : 'html';
}

async function fetchSourceItems(source: IndustryIntelligenceSource): Promise<ParsedIndustryItem[]> {
  const sourceUrl = sourceUrlFor(source);
  if (!sourceUrl) throw new Error('source_url or metadata.feed_url is required');
  const response = await safeFetch(sourceUrl, {
    headers: {
      'User-Agent': 'OBAOL Industry Intelligence/1.0',
      Accept: 'application/rss+xml, application/xml, text/xml, text/html, application/json;q=0.9, */*;q=0.8',
    },
  }, { timeoutMs: 20000 });
  if (!response.ok) throw new Error(`source_fetch_${response.status}`);
  const text = await response.text();
  const parser = parserFor(source);
  if (parser === 'rss') return parseIndustryRssItems(text, source);
  if (parser === 'api') {
    try {
      const parsed = JSON.parse(text);
      const rows = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.items) ? parsed.items : Array.isArray(parsed?.results) ? parsed.results : [];
      return rows.map((row: any) => ({
        title: normalizeText(row.title ?? row.name) ?? '',
        summary: normalizeText(row.summary ?? row.description ?? row.excerpt),
        source_name: source.name,
        source_url: normalizeText(row.source_url ?? row.url ?? row.link),
        category: normalizeText(row.category),
        sector: normalizeText(row.sector) ?? source.sector_focus?.[0] ?? null,
        geography: normalizeText(row.geography ?? row.region) ?? source.region ?? 'India',
        funding_stage: normalizeText(row.funding_stage ?? row.stage),
        amount_text: normalizeText(row.amount_text ?? row.amount),
        deadline_date: normalizeText(row.deadline_date ?? row.deadline),
        opportunity_date: normalizeText(row.opportunity_date ?? row.published_at ?? row.date),
        organizer_or_investor: normalizeText(row.organizer_or_investor ?? row.organizer ?? row.investor) ?? source.name,
        tags: row.tags,
        raw_payload: row,
        confidence: 0.75,
      })).filter((item: ParsedIndustryItem) => normalizeText(item.title) && isRelevantIndustryItem(item));
    } catch {
      return parseIndustryHtmlItems(text, sourceUrl, source);
    }
  }
  return parseIndustryHtmlItems(text, sourceUrl, source);
}

export async function listIndustrySources(): Promise<IndustryIntelligenceSource[]> {
  const { data, error } = await supabase
    .from('industry_intelligence_sources')
    .select('*')
    .eq('status', 'active')
    .order('name', { ascending: true });

  if (error) {
    if (isSchemaMissingError(error)) return FALLBACK_SOURCES;
    throw error;
  }

  const rows = (data ?? []) as IndustryIntelligenceSource[];
  if (rows.length === 0) return FALLBACK_SOURCES;
  return rows.map((row) => ({ ...row, source_origin: 'db' }));
}

async function resolveSourceByCode(code: string): Promise<IndustryIntelligenceSource | null> {
  const normalized = String(code || '').trim().toLowerCase();
  if (!normalized) return null;

  const { data, error } = await supabase
    .from('industry_intelligence_sources')
    .select('*')
    .eq('code', normalized)
    .maybeSingle();

  if (error) {
    if (error.code === 'PGRST116' || isSchemaMissingError(error)) return null;
    throw error;
  }
  return (data ?? null) as IndustryIntelligenceSource | null;
}

async function upsertOpportunity(params: {
  source: IndustryIntelligenceSource | null;
  sourceCode: string;
  runId: string;
  item: IndustryOpportunityInput;
  userId?: string | null;
  operatorId?: string | null;
}): Promise<'inserted' | 'deduped'> {
  const title = normalizeText(params.item.title);
  if (!title) throw new Error('title is required');

  const dedupeHash = makeIndustryOpportunityDedupeHash(params.sourceCode, params.item);
  const existing = await supabase
    .from('industry_intelligence_opportunities')
    .select('id')
    .eq('dedupe_hash', dedupeHash)
    .maybeSingle();

  if (existing.error && existing.error.code !== 'PGRST116') throw existing.error;
  if (existing.data?.id) return 'deduped';

  const category = inferCategory(params.item);
  const relevanceScore = normalizeScore(params.item.relevance_score) ?? relevanceFor({ ...params.item, category });

  const { error } = await supabase.from('industry_intelligence_opportunities').insert({
    source_id: params.source?.id ?? null,
    source_code: params.sourceCode,
    source_name: normalizeText(params.item.source_name) ?? params.source?.name ?? params.sourceCode,
    source_url: normalizeIndustrySourceUrl(params.item.source_url),
    title,
    summary: normalizeText(params.item.summary),
    category,
    sector: normalizeText(params.item.sector) ?? 'agri-tech',
    geography: normalizeText(params.item.geography) ?? 'India',
    funding_stage: normalizeText(params.item.funding_stage),
    amount_text: normalizeText(params.item.amount_text),
    deadline_date: normalizeText(params.item.deadline_date),
    opportunity_date: normalizeText(params.item.opportunity_date) ?? nowIso(),
    organizer_or_investor: normalizeText(params.item.organizer_or_investor),
    relevance_score: relevanceScore,
    status: 'new',
    tags: normalizeTags(params.item.tags),
    useful_for_funding: params.item.useful_for_funding ?? true,
    useful_for_clients: params.item.useful_for_clients ?? false,
    useful_for_partnerships: params.item.useful_for_partnerships ?? false,
    useful_for_content: params.item.useful_for_content ?? false,
    dedupe_hash: dedupeHash,
    raw_payload: params.item.raw_payload ?? params.item,
    fetched_run_id: params.runId,
    created_by: params.userId ?? null,
    operator_id: params.operatorId ?? null,
  });

  if (error) throw error;
  return 'inserted';
}

export async function createIndustryFetchRun(params: {
  sourceCodes: string[];
  triggerMode: string;
  itemsBySource?: Record<string, IndustryOpportunityInput[]>;
  userId?: string | null;
  operatorId?: string | null;
}) {
  const uniqueSourceCodes = Array.from(
    new Set((params.sourceCodes ?? []).map((s) => String(s).trim().toLowerCase()).filter(Boolean))
  );
  if (uniqueSourceCodes.length === 0) throw new Error('At least one source_code is required');

  const runSourceCode = uniqueSourceCodes.length === 1 ? uniqueSourceCodes[0] : 'multi';
  const { data: run, error: runError } = await supabase
    .from('industry_intelligence_fetch_runs')
    .insert({
      source_code: runSourceCode,
      trigger_mode: params.triggerMode,
      status: 'running',
      started_at: nowIso(),
      created_by: params.userId ?? null,
      operator_id: params.operatorId ?? null,
      metadata: { source_codes: uniqueSourceCodes },
    })
    .select('*')
    .single();

  if (runError) throw runError;

  let totalReceived = 0;
  let inserted = 0;
  let deduped = 0;
  let failed = 0;
  const errors: string[] = [];
  const sourceResults: Array<Record<string, unknown>> = [];

  const fallbackByCode = new Map(FALLBACK_SOURCES.map((source) => [source.code, source]));

  for (let index = 0; index < uniqueSourceCodes.length; index += 1) {
    const sourceCode = uniqueSourceCodes[index];
    const started = Date.now();
    const source = (await resolveSourceByCode(sourceCode)) ?? fallbackByCode.get(sourceCode) ?? null;
    const mode = source?.mode ?? 'manual';
    let items = params.itemsBySource?.[sourceCode] ?? [];
    if (!Array.isArray(items) || items.length === 0) {
      items = source && mode !== 'webhook' && mode !== 'manual' ? await fetchSourceItems(source) : [];
    }

    let sourceInserted = 0;
    let sourceDeduped = 0;
    let sourceFailed = 0;
    let firstError: string | null = null;
    totalReceived += items.length;

    for (const item of items) {
      try {
        const result = await upsertOpportunity({
          source,
          sourceCode,
          runId: run.id,
          item,
          userId: params.userId,
          operatorId: params.operatorId,
        });
        if (result === 'inserted') {
          inserted += 1;
          sourceInserted += 1;
        } else {
          deduped += 1;
          sourceDeduped += 1;
        }
      } catch (err: unknown) {
        failed += 1;
        sourceFailed += 1;
        const message = err instanceof Error ? err.message : 'unknown error';
        firstError = firstError ?? message;
        errors.push(`${sourceCode}: ${message}`);
      }
    }

    sourceResults.push({
      source_code: sourceCode,
      mode,
      status: sourceFailed > 0 ? 'completed_with_errors' : 'completed',
      latency_ms: Date.now() - started,
      fetched_count: items.length,
      inserted_count: sourceInserted,
      deduped_count: sourceDeduped,
      failed_count: sourceFailed,
      error_message: firstError,
    });

    if (source?.id && !String(source.id).startsWith('fallback-')) {
      await supabase
        .from('industry_intelligence_sources')
        .update({
          last_checked_at: nowIso(),
          last_success_at: sourceFailed > 0 ? source.last_success_at ?? null : nowIso(),
          last_error: firstError,
          health_status: sourceFailed > 0 ? 'error' : 'healthy',
          updated_at: nowIso(),
        })
        .eq('id', source.id);
    }
  }

  const { data: updatedRun, error: updateError } = await supabase
    .from('industry_intelligence_fetch_runs')
    .update({
      status: failed > 0 ? 'completed_with_errors' : 'completed',
      total_received: totalReceived,
      inserted_count: inserted,
      deduped_count: deduped,
      failed_count: failed,
      completed_at: nowIso(),
      error_summary: errors.length > 0 ? errors.slice(0, 10).join(' | ') : null,
      metadata: { source_codes: uniqueSourceCodes, source_results: sourceResults },
    })
    .eq('id', run.id)
    .select('*')
    .single();

  if (updateError) throw updateError;

  return {
    run: updatedRun as IndustryFetchRun,
    source_results: sourceResults,
    summary: {
      source_count: uniqueSourceCodes.length,
      total_received: totalReceived,
      inserted_count: inserted,
      deduped_count: deduped,
      failed_count: failed,
    },
  };
}

export async function listIndustryFetchRuns(limit: number = 20): Promise<IndustryFetchRun[]> {
  const { data, error } = await supabase
    .from('industry_intelligence_fetch_runs')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    if (isSchemaMissingError(error)) return [];
    throw error;
  }
  return (data ?? []) as IndustryFetchRun[];
}

export async function getIndustrySummary() {
  const [total, newRows, shortlisted, applied, recentRuns, sources] = await Promise.all([
    supabase.from('industry_intelligence_opportunities').select('id', { count: 'exact', head: true }),
    supabase.from('industry_intelligence_opportunities').select('id', { count: 'exact', head: true }).eq('status', 'new'),
    supabase.from('industry_intelligence_opportunities').select('id', { count: 'exact', head: true }).eq('status', 'shortlisted'),
    supabase.from('industry_intelligence_opportunities').select('id', { count: 'exact', head: true }).eq('status', 'applied'),
    supabase.from('industry_intelligence_fetch_runs').select('*').order('created_at', { ascending: false }).limit(5),
    supabase.from('industry_intelligence_sources').select('id,code,name,health_status,last_checked_at,last_success_at,last_error').eq('status', 'active'),
  ]);

  const schemaError = [total.error, newRows.error, shortlisted.error, applied.error, recentRuns.error, sources.error].find(isSchemaMissingError);
  if (schemaError) {
    return {
      total: 0,
      new_count: 0,
      shortlisted_count: 0,
      applied_count: 0,
      last_run: null,
      source_health: [],
    };
  }
  const nonSchemaError = [total.error, newRows.error, shortlisted.error, applied.error, recentRuns.error, sources.error].find(Boolean);
  if (nonSchemaError) throw nonSchemaError;

  const sourceRows = sources.data ?? [];
  const healthySources = sourceRows.filter((source: any) => source.health_status === 'healthy').length;

  return {
    total: Number(total.count ?? 0),
    new_count: Number(newRows.count ?? 0),
    shortlisted_count: Number(shortlisted.count ?? 0),
    applied_count: Number(applied.count ?? 0),
    last_run: recentRuns.data?.[0] ?? null,
    source_health: sourceRows,
    healthy_sources: healthySources,
    total_sources: sourceRows.length,
  };
}

export async function listIndustryOpportunities(filters: IndustryOpportunityFilters) {
  const page = Math.max(1, Number(filters.page ?? 1));
  const pageSize = Math.min(200, Math.max(1, Number(filters.page_size ?? 25)));
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  let query = supabase
    .from('industry_intelligence_opportunities')
    .select('*', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(from, to);

  if (filters.source_code) query = query.eq('source_code', String(filters.source_code));
  if (filters.category) query = query.eq('category', String(filters.category));
  if (filters.sector) query = query.ilike('sector', `%${String(filters.sector)}%`);
  if (filters.funding_stage) query = query.ilike('funding_stage', `%${String(filters.funding_stage)}%`);
  if (filters.status) query = query.eq('status', String(filters.status));
  if (filters.from) query = query.gte('created_at', filters.from);
  if (filters.to) query = query.lte('created_at', filters.to);
  if (filters.q) {
    query = query.or(`title.ilike.%${filters.q}%,summary.ilike.%${filters.q}%,organizer_or_investor.ilike.%${filters.q}%,notes.ilike.%${filters.q}%`);
  }

  const { data, error, count } = await query;
  if (error) {
    if (isSchemaMissingError(error)) {
      return { rows: [], total: 0, page, page_size: pageSize };
    }
    throw error;
  }

  return {
    rows: data ?? [],
    total: Number(count ?? 0),
    page,
    page_size: pageSize,
  };
}

export async function updateIndustryOpportunity(
  opportunityId: string,
  payload: IndustryOpportunityPatch
) {
  const { data: existing, error: readError } = await supabase
    .from('industry_intelligence_opportunities')
    .select('*')
    .eq('id', opportunityId)
    .single();

  if (readError) throw readError;

  const nextCategory = String(payload.category ?? existing.category) as IndustryOpportunityCategory;
  if (!ALLOWED_CATEGORIES.includes(nextCategory)) {
    throw new Error(`Invalid category. Allowed: ${ALLOWED_CATEGORIES.join(', ')}`);
  }

  const nextStatus = String(payload.status ?? existing.status) as IndustryOpportunityStatus;
  if (!ALLOWED_STATUSES.includes(nextStatus)) {
    throw new Error(`Invalid status. Allowed: ${ALLOWED_STATUSES.join(', ')}`);
  }

  const patch = {
    category: nextCategory,
    sector: payload.sector ?? existing.sector,
    geography: payload.geography ?? existing.geography,
    funding_stage: payload.funding_stage ?? existing.funding_stage,
    status: nextStatus,
    relevance_score: normalizeScore(payload.relevance_score) ?? existing.relevance_score,
    owner: payload.owner ?? existing.owner,
    notes: payload.notes ?? existing.notes,
    tags: payload.tags === undefined ? existing.tags : normalizeTags(payload.tags),
    useful_for_funding: payload.useful_for_funding ?? existing.useful_for_funding,
    useful_for_clients: payload.useful_for_clients ?? existing.useful_for_clients,
    useful_for_partnerships: payload.useful_for_partnerships ?? existing.useful_for_partnerships,
    useful_for_content: payload.useful_for_content ?? existing.useful_for_content,
    updated_at: nowIso(),
  };

  const { data: updated, error: updateError } = await supabase
    .from('industry_intelligence_opportunities')
    .update(patch)
    .eq('id', opportunityId)
    .select('*')
    .single();

  if (updateError) throw updateError;
  return updated;
}

function exportRowsTransform(rows: any[]) {
  return rows.map((row) => ({
    title: row.title,
    source_code: row.source_code,
    source_name: row.source_name,
    source_url: row.source_url,
    category: row.category,
    sector: row.sector,
    geography: row.geography,
    funding_stage: row.funding_stage,
    amount_text: row.amount_text,
    deadline_date: row.deadline_date,
    opportunity_date: row.opportunity_date,
    organizer_or_investor: row.organizer_or_investor,
    relevance_score: row.relevance_score,
    status: row.status,
    owner: row.owner,
    tags: Array.isArray(row.tags) ? row.tags.join(', ') : '',
    useful_for_funding: row.useful_for_funding,
    useful_for_clients: row.useful_for_clients,
    useful_for_partnerships: row.useful_for_partnerships,
    useful_for_content: row.useful_for_content,
    notes: row.notes,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }));
}

export async function exportIndustryOpportunities(filters: IndustryOpportunityFilters, format: 'csv' | 'xlsx') {
  const list = await listIndustryOpportunities({ ...filters, page: 1, page_size: 5000 });
  const rows = exportRowsTransform(list.rows);

  if (format === 'csv') {
    const worksheet = XLSX.utils.json_to_sheet(rows);
    const csv = XLSX.utils.sheet_to_csv(worksheet);
    return {
      contentType: 'text/csv; charset=utf-8',
      fileName: `industry-intelligence-${todayKey()}.csv`,
      buffer: Buffer.from(csv, 'utf-8'),
    };
  }

  const workbook = XLSX.utils.book_new();
  const worksheet = XLSX.utils.json_to_sheet(rows);
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Industry Intelligence');
  const xlsxBuffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });

  return {
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    fileName: `industry-intelligence-${todayKey()}.xlsx`,
    buffer: Buffer.from(xlsxBuffer),
  };
}
