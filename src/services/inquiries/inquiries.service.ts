import crypto from 'crypto';
import XLSX from 'xlsx';
import { supabase } from '../../supabase';
import {
  InquiryCodingPayload,
  InquiryConnectorRun,
  InquiryFetchRun,
  InquiryFilters,
  InquiryIngestItem,
  InquiryQuote,
  InquirySourceCapability,
  InquiryStage,
  QuoteStatus,
  QuoteUpdatePayload,
} from './types';

const ALLOWED_STAGES: InquiryStage[] = ['new', 'reviewed', 'qualified', 'follow_up', 'closed'];
const ALLOWED_QUOTE_STATUS: QuoteStatus[] = ['draft', 'reviewed', 'approved', 'sent', 'closed'];
const FALLBACK_INQUIRY_SOURCES: InquirySourceCapability[] = [
  { id: 'fallback-manual', code: 'manual', name: 'Manual Intake', mode: 'manual_webhook', status: 'active', source_origin: 'fallback', supports_api: false, supports_webhook: true, supports_manual: true, supports_scrape: false, auth_ready: false, health_status: 'fallback', metadata: { category: 'utility', fallback: true, priority: 0 } },
  { id: 'fallback-alibaba', code: 'alibaba', name: 'Alibaba RFQ', mode: 'api_webhook_manual', status: 'active', source_origin: 'fallback', supports_api: true, supports_webhook: true, supports_manual: true, supports_scrape: false, auth_ready: false, health_status: 'fallback', metadata: { category: 'b2b', fallback: true, priority: 1 } },
  { id: 'fallback-tradekey', code: 'tradekey', name: 'TradeKey', mode: 'api_webhook_manual', status: 'active', source_origin: 'fallback', supports_api: true, supports_webhook: true, supports_manual: true, supports_scrape: false, auth_ready: false, health_status: 'fallback', metadata: { category: 'b2b', fallback: true, priority: 2 } },
  { id: 'fallback-ec21', code: 'ec21', name: 'EC21', mode: 'api_webhook_manual', status: 'active', source_origin: 'fallback', supports_api: true, supports_webhook: true, supports_manual: true, supports_scrape: false, auth_ready: false, health_status: 'fallback', metadata: { category: 'b2b', fallback: true, priority: 3 } },
  { id: 'fallback-globalsources', code: 'globalsources', name: 'Global Sources', mode: 'manual_webhook', status: 'active', source_origin: 'fallback', supports_api: false, supports_webhook: true, supports_manual: true, supports_scrape: false, auth_ready: false, health_status: 'fallback', metadata: { category: 'b2b', fallback: true, priority: 4 } },
  { id: 'fallback-indiamart', code: 'indiamart', name: 'IndiaMART', mode: 'api_webhook_manual', status: 'active', source_origin: 'fallback', supports_api: true, supports_webhook: true, supports_manual: true, supports_scrape: false, auth_ready: false, health_status: 'fallback', metadata: { category: 'b2b', fallback: true, priority: 5 } },
  { id: 'fallback-madeinchina', code: 'made_in_china', name: 'Made-in-China', mode: 'api_webhook_manual', status: 'active', source_origin: 'fallback', supports_api: true, supports_webhook: true, supports_manual: true, supports_scrape: false, auth_ready: false, health_status: 'fallback', metadata: { category: 'b2b', fallback: true, priority: 6 } },
  { id: 'fallback-exportersindia', code: 'exportersindia', name: 'ExportersIndia', mode: 'manual_webhook', status: 'active', source_origin: 'fallback', supports_api: false, supports_webhook: true, supports_manual: true, supports_scrape: false, auth_ready: false, health_status: 'fallback', metadata: { category: 'b2b', fallback: true, priority: 7 } },
  { id: 'fallback-go4worldbusiness', code: 'go4worldbusiness', name: 'Go4WorldBusiness', mode: 'manual_webhook', status: 'active', source_origin: 'fallback', supports_api: false, supports_webhook: true, supports_manual: true, supports_scrape: false, auth_ready: false, health_status: 'fallback', metadata: { category: 'b2b', fallback: true, priority: 8 } },
  { id: 'fallback-ecplaza', code: 'ecplaza', name: 'ECPlaza', mode: 'manual_webhook', status: 'active', source_origin: 'fallback', supports_api: false, supports_webhook: true, supports_manual: true, supports_scrape: false, auth_ready: false, health_status: 'fallback', metadata: { category: 'b2b', fallback: true, priority: 9 } },
  { id: 'fallback-dhgate', code: 'dhgate', name: 'DHgate RFQ', mode: 'manual_webhook', status: 'active', source_origin: 'fallback', supports_api: false, supports_webhook: true, supports_manual: true, supports_scrape: false, auth_ready: false, health_status: 'fallback', metadata: { category: 'b2b', fallback: true, priority: 10 } },
  { id: 'fallback-fiber2fashion', code: 'fiber2fashion', name: 'Fiber2Fashion', mode: 'manual_webhook', status: 'active', source_origin: 'fallback', supports_api: false, supports_webhook: true, supports_manual: true, supports_scrape: false, auth_ready: false, health_status: 'fallback', metadata: { category: 'b2b', fallback: true, priority: 11 } },
  { id: 'fallback-toocle', code: 'toocle', name: 'Toocle', mode: 'manual_webhook', status: 'active', source_origin: 'fallback', supports_api: false, supports_webhook: true, supports_manual: true, supports_scrape: false, auth_ready: false, health_status: 'fallback', metadata: { category: 'b2b', fallback: true, priority: 12 } },
  { id: 'fallback-ecvv', code: 'ecvv', name: 'ECVV', mode: 'manual_webhook', status: 'active', source_origin: 'fallback', supports_api: false, supports_webhook: true, supports_manual: true, supports_scrape: false, auth_ready: false, health_status: 'fallback', metadata: { category: 'b2b', fallback: true, priority: 13 } },
  { id: 'fallback-hktdc', code: 'hktdc', name: 'HKTDC Sourcing', mode: 'manual_webhook', status: 'active', source_origin: 'fallback', supports_api: false, supports_webhook: true, supports_manual: true, supports_scrape: false, auth_ready: false, health_status: 'fallback', metadata: { category: 'b2b', fallback: true, priority: 14 } },
  { id: 'fallback-europages', code: 'europages', name: 'Europages', mode: 'manual_webhook', status: 'active', source_origin: 'fallback', supports_api: false, supports_webhook: true, supports_manual: true, supports_scrape: false, auth_ready: false, health_status: 'fallback', metadata: { category: 'b2b', fallback: true, priority: 15 } },
  { id: 'fallback-ekompass', code: 'kompass', name: 'Kompass', mode: 'manual_webhook', status: 'active', source_origin: 'fallback', supports_api: false, supports_webhook: true, supports_manual: true, supports_scrape: false, auth_ready: false, health_status: 'fallback', metadata: { category: 'b2b', fallback: true, priority: 16 } },
  { id: 'fallback-thomasnet', code: 'thomasnet', name: 'Thomasnet', mode: 'manual_webhook', status: 'active', source_origin: 'fallback', supports_api: false, supports_webhook: true, supports_manual: true, supports_scrape: false, auth_ready: false, health_status: 'fallback', metadata: { category: 'b2b', fallback: true, priority: 17 } },
  { id: 'fallback-tradeindia', code: 'tradeindia', name: 'TradeIndia', mode: 'manual_webhook', status: 'active', source_origin: 'fallback', supports_api: false, supports_webhook: true, supports_manual: true, supports_scrape: false, auth_ready: false, health_status: 'fallback', metadata: { category: 'b2b', fallback: true, priority: 18 } },
  { id: 'fallback-power2sme', code: 'power2sme', name: 'Power2SME', mode: 'manual_webhook', status: 'active', source_origin: 'fallback', supports_api: false, supports_webhook: true, supports_manual: true, supports_scrape: false, auth_ready: false, health_status: 'fallback', metadata: { category: 'b2b', fallback: true, priority: 19 } },
  { id: 'fallback-bizvibe', code: 'bizvibe', name: 'BizVibe', mode: 'manual_webhook', status: 'active', source_origin: 'fallback', supports_api: false, supports_webhook: true, supports_manual: true, supports_scrape: false, auth_ready: false, health_status: 'fallback', metadata: { category: 'b2b', fallback: true, priority: 20 } },
  { id: 'fallback-wholesalecentral', code: 'wholesalecentral', name: 'Wholesale Central', mode: 'manual_webhook', status: 'active', source_origin: 'fallback', supports_api: false, supports_webhook: true, supports_manual: true, supports_scrape: false, auth_ready: false, health_status: 'fallback', metadata: { category: 'b2b', fallback: true, priority: 21 } },
  { id: 'fallback-tradewheel', code: 'tradewheel', name: 'TradeWheel', mode: 'manual_webhook', status: 'active', source_origin: 'fallback', supports_api: false, supports_webhook: true, supports_manual: true, supports_scrape: false, auth_ready: false, health_status: 'fallback', metadata: { category: 'b2b', fallback: true, priority: 22 } },
  { id: 'fallback-yellopages', code: 'yellowpages_b2b', name: 'Yellow Pages B2B', mode: 'manual_webhook', status: 'active', source_origin: 'fallback', supports_api: false, supports_webhook: true, supports_manual: true, supports_scrape: false, auth_ready: false, health_status: 'fallback', metadata: { category: 'b2b', fallback: true, priority: 23 } },
  { id: 'fallback-sourcifychina', code: 'sourcifychina', name: 'SourcifyChina', mode: 'manual_webhook', status: 'active', source_origin: 'fallback', supports_api: false, supports_webhook: true, supports_manual: true, supports_scrape: false, auth_ready: false, health_status: 'fallback', metadata: { category: 'b2b', fallback: true, priority: 24 } },
  { id: 'fallback-tradeford', code: 'tradeford', name: 'TradeFord', mode: 'manual_webhook', status: 'active', source_origin: 'fallback', supports_api: false, supports_webhook: true, supports_manual: true, supports_scrape: false, auth_ready: false, health_status: 'fallback', metadata: { category: 'b2b', fallback: true, priority: 25 } },
  { id: 'fallback-worldbid', code: 'worldbid', name: 'WorldBid B2B', mode: 'manual_webhook', status: 'active', source_origin: 'fallback', supports_api: false, supports_webhook: true, supports_manual: true, supports_scrape: false, auth_ready: false, health_status: 'fallback', metadata: { category: 'b2b', fallback: true, priority: 26 } },
  { id: 'fallback-exporthub', code: 'exporthub', name: 'ExportHub', mode: 'manual_webhook', status: 'active', source_origin: 'fallback', supports_api: false, supports_webhook: true, supports_manual: true, supports_scrape: false, auth_ready: false, health_status: 'fallback', metadata: { category: 'b2b', fallback: true, priority: 27 } },
  { id: 'fallback-kwipped', code: 'kwipped', name: 'KWIPPED', mode: 'manual_webhook', status: 'active', source_origin: 'fallback', supports_api: false, supports_webhook: true, supports_manual: true, supports_scrape: false, auth_ready: false, health_status: 'fallback', metadata: { category: 'b2b', fallback: true, priority: 28 } },
  { id: 'fallback-ampliz', code: 'ampliz_b2b', name: 'Ampliz B2B', mode: 'manual_webhook', status: 'active', source_origin: 'fallback', supports_api: false, supports_webhook: true, supports_manual: true, supports_scrape: false, auth_ready: false, health_status: 'fallback', metadata: { category: 'b2b', fallback: true, priority: 29 } },
];

function isSchemaMissingError(err: any): boolean {
  const code = String(err?.code ?? '');
  const msg = String(err?.message ?? '').toLowerCase();
  return (
    code === '42P01' ||
    code === 'PGRST205' ||
    msg.includes('schema cache') ||
    msg.includes('could not find the table') ||
    msg.includes('does not exist')
  );
}

function migrationRequiredError(scope: string): Error {
  return new Error(
    `Inquiry schema not ready for ${scope}. Apply inquiry migrations and restart backend.`
  );
}

function normalizeText(value: unknown): string | null {
  const v = String(value ?? '').trim();
  return v.length > 0 ? v : null;
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

async function generateInquiryCode(): Promise<string> {
  const day = todayKey();
  const prefix = `INQ-${day}-`;
  const { count, error } = await supabase
    .from('buyer_inquiries')
    .select('id', { count: 'exact', head: true })
    .like('inquiry_code', `${prefix}%`);

  if (error) throw error;
  const next = Number(count ?? 0) + 1;
  return `${prefix}${String(next).padStart(4, '0')}`;
}

async function generateQuoteCode(): Promise<string> {
  const day = todayKey();
  const prefix = `QT-${day}-`;
  const { count, error } = await supabase
    .from('inquiry_quotes')
    .select('id', { count: 'exact', head: true })
    .like('quote_code', `${prefix}%`);

  if (error) throw error;
  const next = Number(count ?? 0) + 1;
  return `${prefix}${String(next).padStart(4, '0')}`;
}

function inferQuantityBand(quantityRequested: string | null): string | null {
  if (!quantityRequested) return null;
  const num = Number(String(quantityRequested).replace(/[^0-9.]/g, ''));
  if (!Number.isFinite(num) || num <= 0) return null;
  if (num < 100) return 'small';
  if (num < 1000) return 'medium';
  return 'large';
}

function inferUrgency(message: string): string | null {
  const m = message.toLowerCase();
  if (m.includes('urgent') || m.includes('asap') || m.includes('immediately')) return 'high';
  if (m.includes('soon') || m.includes('quick')) return 'medium';
  return 'normal';
}

function inferBuyerType(raw: InquiryIngestItem): string | null {
  const company = String(raw.buyer_company ?? '').toLowerCase();
  const msg = String(raw.message ?? '').toLowerCase();
  if (company.includes('trading') || msg.includes('distributor')) return 'distributor';
  if (company.includes('retail') || msg.includes('retail')) return 'retailer';
  if (msg.includes('import') || msg.includes('procurement')) return 'importer';
  return 'unknown';
}

function makeDedupeHash(sourceCode: string, input: InquiryIngestItem): string {
  const parts = [
    sourceCode,
    String(input.source_external_id ?? '').trim().toLowerCase(),
    String(input.buyer_email ?? '').trim().toLowerCase(),
    String(input.buyer_phone ?? '').trim().toLowerCase(),
    String(input.subject ?? '').trim().toLowerCase(),
    String(input.message ?? '').trim().toLowerCase(),
  ];
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex');
}

function fakeAdapterItems(sourceCode: string): InquiryIngestItem[] {
  const stamp = Date.now();
  return [
    {
      source_external_id: `${sourceCode.toUpperCase()}-${stamp}`,
      buyer_name: `${sourceCode} buyer`,
      buyer_company: `${sourceCode} trading co`,
      buyer_email: `${sourceCode}-buyer-${stamp}@example.com`,
      buyer_country: 'Global',
      subject: `RFQ from ${sourceCode}`,
      message: `Need CIF quote for yellow maize from source ${sourceCode}.`,
      quantity_requested: '250 MT',
      product_interest: 'Yellow Maize',
      raw_payload: { synthetic: true, sourceCode },
    },
  ];
}

export async function listInquirySources(): Promise<InquirySourceCapability[]> {
  const { data, error } = await supabase
    .from('inquiry_sources')
    .select('*')
    .eq('status', 'active')
    .order('name', { ascending: true });

  if (error) {
    if (error.code === 'PGRST205' || error.code === '42P01' || isSchemaMissingError(error)) {
      return FALLBACK_INQUIRY_SOURCES;
    }
    throw error;
  }
  const rows = (data ?? []) as InquirySourceCapability[];
  if (rows.length === 0) return FALLBACK_INQUIRY_SOURCES;
  return rows.map((row) => ({ ...row, source_origin: 'db' }));
}

async function resolveSourceByCode(code: string): Promise<InquirySourceCapability | null> {
  const normalized = String(code || '').trim().toLowerCase();
  if (!normalized) return null;

  const { data, error } = await supabase
    .from('inquiry_sources')
    .select('*')
    .eq('code', normalized)
    .maybeSingle();

  if (error && error.code !== 'PGRST116') throw error;
  return (data ?? null) as InquirySourceCapability | null;
}

async function upsertInquiryRow(params: {
  source: InquirySourceCapability | null;
  sourceCode: string;
  runId: string;
  item: InquiryIngestItem;
  userId?: string | null;
  operatorId?: string | null;
}): Promise<'inserted' | 'deduped'> {
  const message = String(params.item.message ?? '').trim();
  if (!message) throw new Error('message is required');

  const sourceExternalId = normalizeText(params.item.source_external_id);
  const dedupeHash = makeDedupeHash(params.sourceCode, params.item);

  const existingQuery = sourceExternalId
    ? supabase
        .from('buyer_inquiries')
        .select('id')
        .eq('source_code', params.sourceCode)
        .eq('source_external_id', sourceExternalId)
        .maybeSingle()
    : supabase.from('buyer_inquiries').select('id').eq('dedupe_hash', dedupeHash).maybeSingle();

  const existingResult = await existingQuery;
  if (existingResult.error && existingResult.error.code !== 'PGRST116') throw existingResult.error;
  if (existingResult.data?.id) return 'deduped';

  const inquiryCode = await generateInquiryCode();

  const insertPayload = {
    inquiry_code: inquiryCode,
    source_id: params.source?.id ?? null,
    source_code: params.sourceCode,
    source_external_id: sourceExternalId,
    fetch_run_id: params.runId,
    dedupe_hash: dedupeHash,
    buyer_name: normalizeText(params.item.buyer_name),
    buyer_company: normalizeText(params.item.buyer_company),
    buyer_email: normalizeText(params.item.buyer_email),
    buyer_phone: normalizeText(params.item.buyer_phone),
    buyer_country: normalizeText(params.item.buyer_country),
    subject: normalizeText(params.item.subject),
    message,
    quantity_requested: normalizeText(params.item.quantity_requested),
    product_interest: normalizeText(params.item.product_interest),
    quantity_band: inferQuantityBand(normalizeText(params.item.quantity_requested)),
    region: normalizeText(params.item.buyer_country),
    urgency: inferUrgency(message),
    buyer_type: inferBuyerType(params.item),
    stage: 'new',
    coded: false,
    raw_payload: params.item.raw_payload ?? params.item,
    inquiry_received_at: normalizeText(params.item.inquiry_received_at) ?? nowIso(),
    created_by: params.userId ?? null,
    operator_id: params.operatorId ?? null,
  };

  const { error } = await supabase.from('buyer_inquiries').insert(insertPayload);
  if (error) throw error;

  return 'inserted';
}

export async function createFetchRun(params: {
  sourceCode: string;
  triggerMode: string;
  items: InquiryIngestItem[];
  userId?: string | null;
  operatorId?: string | null;
}) {
  return createMultiSourceFetchRun({
    sourceCodes: [params.sourceCode],
    triggerMode: params.triggerMode,
    itemsBySource: { [params.sourceCode]: params.items },
    userId: params.userId,
    operatorId: params.operatorId,
  });
}

export async function createMultiSourceFetchRun(params: {
  sourceCodes: string[];
  triggerMode: string;
  itemsBySource?: Record<string, InquiryIngestItem[]>;
  userId?: string | null;
  operatorId?: string | null;
}) {
  const uniqueSourceCodes = Array.from(new Set((params.sourceCodes ?? []).map((s) => String(s).trim().toLowerCase()).filter(Boolean)));
  if (uniqueSourceCodes.length === 0) throw new Error('At least one source_code is required');

  const now = nowIso();
  const runSourceCode = uniqueSourceCodes.length === 1 ? uniqueSourceCodes[0] : 'multi';

  const { data: run, error: runError } = await supabase
    .from('inquiry_fetch_runs')
    .insert({
      source_code: runSourceCode,
      trigger_mode: params.triggerMode,
      status: 'running',
      total_received: 0,
      created_by: params.userId ?? null,
      operator_id: params.operatorId ?? null,
      started_at: now,
      metadata: { source_codes: uniqueSourceCodes, mode: params.triggerMode },
    })
    .select('*')
    .single();

  if (runError) throw runError;

  let totalReceived = 0;
  let inserted = 0;
  let deduped = 0;
  let failed = 0;
  const errors: string[] = [];
  const connectors: InquiryConnectorRun[] = [];

  for (const sourceCode of uniqueSourceCodes) {
    const sourceStarted = Date.now();
    const source = await resolveSourceByCode(sourceCode);
    const connectorMode = source?.supports_api ? 'api' : 'manual';

    let sourceItems = params.itemsBySource?.[sourceCode] ?? [];
    if (!Array.isArray(sourceItems) || sourceItems.length === 0) {
      sourceItems = source?.supports_api ? fakeAdapterItems(sourceCode) : [];
    }

    let sourceInserted = 0;
    let sourceDeduped = 0;
    let sourceFailed = 0;
    let connectorError: string | null = null;

    totalReceived += sourceItems.length;

    for (const item of sourceItems) {
      try {
        const status = await upsertInquiryRow({
          source,
          sourceCode,
          runId: run.id,
          item,
          userId: params.userId,
          operatorId: params.operatorId,
        });
        if (status === 'inserted') {
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
        connectorError = connectorError ?? message;
        errors.push(`${sourceCode}: ${message}`);
      }
    }

    const latencyMs = Date.now() - sourceStarted;
    const connectorInsert = await supabase
      .from('source_connector_runs')
      .insert({
        fetch_run_id: run.id,
        source_id: source?.id ?? null,
        source_code: sourceCode,
        mode: connectorMode,
        status: sourceFailed > 0 ? 'completed_with_errors' : 'completed',
        latency_ms: latencyMs,
        fetched_count: sourceItems.length,
        inserted_count: sourceInserted,
        deduped_count: sourceDeduped,
        failed_count: sourceFailed,
        error_message: connectorError,
        metadata: {
          supports_api: source?.supports_api ?? false,
          supports_webhook: source?.supports_webhook ?? true,
          auth_ready: source?.auth_ready ?? false,
        },
      })
      .select('*')
      .single();

    if (!connectorInsert.error && connectorInsert.data) connectors.push(connectorInsert.data as InquiryConnectorRun);
  }

  const { data: updatedRun, error: updateError } = await supabase
    .from('inquiry_fetch_runs')
    .update({
      status: failed > 0 ? 'completed_with_errors' : 'completed',
      total_received: totalReceived,
      inserted_count: inserted,
      deduped_count: deduped,
      failed_count: failed,
      completed_at: nowIso(),
      error_summary: errors.length > 0 ? errors.slice(0, 10).join(' | ') : null,
      metadata: { source_codes: uniqueSourceCodes, mode: params.triggerMode, connector_runs: connectors.length },
    })
    .eq('id', run.id)
    .select('*')
    .single();

  if (updateError) throw updateError;

  return {
    run: updatedRun as InquiryFetchRun,
    connector_runs: connectors,
    summary: {
      source_count: uniqueSourceCodes.length,
      total_received: totalReceived,
      inserted_count: inserted,
      deduped_count: deduped,
      failed_count: failed,
    },
  };
}

export async function listFetchRuns(limit: number = 20): Promise<InquiryFetchRun[]> {
  const { data, error } = await supabase
    .from('inquiry_fetch_runs')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    if (error.code === 'PGRST205' || error.code === '42P01') return [];
    throw error;
  }
  return (data ?? []) as InquiryFetchRun[];
}

export async function listConnectorRuns(fetchRunId?: string | null, limit: number = 100): Promise<InquiryConnectorRun[]> {
  let query = supabase
    .from('source_connector_runs')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (fetchRunId) query = query.eq('fetch_run_id', fetchRunId);

  const { data, error } = await query;
  if (error) {
    if (error.code === 'PGRST205' || error.code === '42P01') return [];
    throw error;
  }

  return (data ?? []) as InquiryConnectorRun[];
}

export async function listInquiries(filters: InquiryFilters) {
  const page = Math.max(1, Number(filters.page ?? 1));
  const pageSize = Math.min(200, Math.max(1, Number(filters.page_size ?? 25)));
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  let query = supabase
    .from('buyer_inquiries')
    .select('*', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(from, to);

  if (filters.source_code) query = query.eq('source_code', String(filters.source_code));
  if (filters.stage) query = query.eq('stage', String(filters.stage));
  if (filters.coded === 'true') query = query.eq('coded', true);
  if (filters.coded === 'false') query = query.eq('coded', false);
  if (filters.from) query = query.gte('created_at', filters.from);
  if (filters.to) query = query.lte('created_at', filters.to);
  if (filters.q) {
    query = query.or(`inquiry_code.ilike.%${filters.q}%,buyer_name.ilike.%${filters.q}%,buyer_email.ilike.%${filters.q}%,message.ilike.%${filters.q}%`);
  }

  const { data, error, count } = await query;
  if (error) {
    if (isSchemaMissingError(error)) {
      return {
        rows: [],
        total: 0,
        page,
        page_size: pageSize,
      };
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

export async function updateInquiryCoding(
  inquiryId: string,
  payload: InquiryCodingPayload,
  changedBy?: string | null
) {
  const { data: existing, error: readError } = await supabase
    .from('buyer_inquiries')
    .select('*')
    .eq('id', inquiryId)
    .single();

  if (readError) throw readError;

  const nextStage = payload.stage ?? existing.stage;
  if (!ALLOWED_STAGES.includes(nextStage as InquiryStage)) {
    throw new Error(`Invalid stage. Allowed: ${ALLOWED_STAGES.join(', ')}`);
  }

  const patch = {
    product_interest: payload.product_interest ?? existing.product_interest,
    quantity_band: payload.quantity_band ?? existing.quantity_band,
    region: payload.region ?? existing.region,
    urgency: payload.urgency ?? existing.urgency,
    buyer_type: payload.buyer_type ?? existing.buyer_type,
    stage: nextStage,
    priority: payload.priority ?? existing.priority,
    owner: payload.owner ?? existing.owner,
    notes: payload.notes ?? existing.notes,
    coded: true,
    coded_at: nowIso(),
    coded_by: changedBy ?? null,
    updated_at: nowIso(),
  };

  const { data: updated, error: updateError } = await supabase
    .from('buyer_inquiries')
    .update(patch)
    .eq('id', inquiryId)
    .select('*')
    .single();

  if (updateError) throw updateError;

  const changedFields: Record<string, unknown> = {};
  const keys = Object.keys(payload) as (keyof InquiryCodingPayload)[];
  for (const key of keys) changedFields[key] = payload[key];

  await supabase.from('inquiry_coding_events').insert({
    inquiry_id: inquiryId,
    previous_stage: existing.stage,
    new_stage: nextStage,
    changed_fields: changedFields,
    changed_by: changedBy ?? null,
    notes: payload.notes ?? null,
  });

  return updated;
}

function exportRowsTransform(rows: any[]) {
  return rows.map((row) => ({
    inquiry_code: row.inquiry_code,
    source_code: row.source_code,
    source_external_id: row.source_external_id,
    buyer_name: row.buyer_name,
    buyer_company: row.buyer_company,
    buyer_email: row.buyer_email,
    buyer_phone: row.buyer_phone,
    buyer_country: row.buyer_country,
    subject: row.subject,
    message: row.message,
    quantity_requested: row.quantity_requested,
    product_interest: row.product_interest,
    quantity_band: row.quantity_band,
    region: row.region,
    urgency: row.urgency,
    buyer_type: row.buyer_type,
    stage: row.stage,
    priority: row.priority,
    owner: row.owner,
    notes: row.notes,
    coded: row.coded,
    inquiry_received_at: row.inquiry_received_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }));
}

export async function exportInquiries(filters: InquiryFilters, format: 'csv' | 'xlsx') {
  const list = await listInquiries({ ...filters, page: 1, page_size: 5000 });
  const rows = exportRowsTransform(list.rows);

  if (format === 'csv') {
    const worksheet = XLSX.utils.json_to_sheet(rows);
    const csv = XLSX.utils.sheet_to_csv(worksheet);
    return {
      contentType: 'text/csv; charset=utf-8',
      fileName: `inquiries-${todayKey()}.csv`,
      buffer: Buffer.from(csv, 'utf-8'),
    };
  }

  const workbook = XLSX.utils.book_new();
  const worksheet = XLSX.utils.json_to_sheet(rows);
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Inquiries');
  const xlsxBuffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });

  return {
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    fileName: `inquiries-${todayKey()}.xlsx`,
    buffer: Buffer.from(xlsxBuffer),
  };
}

export async function createQuoteDraft(input: {
  inquiry_id: string;
  price?: number | null;
  quantity?: string | null;
  currency?: string | null;
  incoterm?: string | null;
  validity_date?: string | null;
  terms?: string | null;
  owner?: string | null;
  notes?: string | null;
  createdBy?: string | null;
}) {
  const inquiryId = String(input.inquiry_id ?? '').trim();
  if (!inquiryId) throw new Error('inquiry_id is required');

  const quoteCode = await generateQuoteCode();

  const { data, error } = await supabase
    .from('inquiry_quotes')
    .insert({
      quote_code: quoteCode,
      inquiry_id: inquiryId,
      price: input.price ?? null,
      quantity: normalizeText(input.quantity),
      currency: normalizeText(input.currency) ?? 'USD',
      incoterm: normalizeText(input.incoterm),
      validity_date: normalizeText(input.validity_date),
      terms: normalizeText(input.terms),
      status: 'draft',
      owner: normalizeText(input.owner),
      notes: normalizeText(input.notes),
      created_by: input.createdBy ?? null,
      updated_by: input.createdBy ?? null,
    })
    .select('*')
    .single();

  if (error) {
    if (isSchemaMissingError(error)) throw migrationRequiredError('quote_draft_create');
    throw error;
  }

  await supabase.from('inquiry_quote_events').insert({
    quote_id: data.id,
    previous_status: null,
    new_status: 'draft',
    changed_fields: { quote_code: quoteCode },
    changed_by: input.createdBy ?? null,
    note: 'Quote draft created',
  });

  return data as InquiryQuote;
}

export async function listQuotes(filters: {
  status?: string | null;
  source_code?: string | null;
  q?: string | null;
  owner?: string | null;
  page?: number;
  page_size?: number;
}) {
  const page = Math.max(1, Number(filters.page ?? 1));
  const pageSize = Math.min(200, Math.max(1, Number(filters.page_size ?? 25)));
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  let query = supabase
    .from('inquiry_quotes')
    .select('*, inquiry:buyer_inquiries(inquiry_code,source_code,buyer_name,buyer_email,product_interest)', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(from, to);

  if (filters.status) query = query.eq('status', String(filters.status));
  if (filters.owner) query = query.eq('owner', String(filters.owner));
  if (filters.q) {
    query = query.or(`quote_code.ilike.%${filters.q}%,notes.ilike.%${filters.q}%,terms.ilike.%${filters.q}%`);
  }

  const { data, error, count } = await query;
  if (error) {
    if (isSchemaMissingError(error)) {
      return {
        rows: [],
        total: 0,
        page,
        page_size: pageSize,
      };
    }
    throw error;
  }

  let rows = (data ?? []) as InquiryQuote[];
  if (filters.source_code) {
    rows = rows.filter((r) => String(r.inquiry?.source_code ?? '') === String(filters.source_code));
  }

  return {
    rows,
    total: Number(count ?? 0),
    page,
    page_size: pageSize,
  };
}

export async function updateQuote(
  quoteId: string,
  payload: QuoteUpdatePayload,
  changedBy?: string | null
) {
  const { data: existing, error: readError } = await supabase
    .from('inquiry_quotes')
    .select('*')
    .eq('id', quoteId)
    .single();

  if (readError) {
    if (isSchemaMissingError(readError)) throw migrationRequiredError('quote_update');
    throw readError;
  }

  const nextStatus = (payload.status ?? existing.status) as QuoteStatus;
  if (!ALLOWED_QUOTE_STATUS.includes(nextStatus)) {
    throw new Error(`Invalid quote status. Allowed: ${ALLOWED_QUOTE_STATUS.join(', ')}`);
  }

  const markSent = payload.mark_sent === true || nextStatus === 'sent';

  const patch = {
    price: payload.price ?? existing.price,
    quantity: payload.quantity ?? existing.quantity,
    currency: payload.currency ?? existing.currency,
    incoterm: payload.incoterm ?? existing.incoterm,
    validity_date: payload.validity_date ?? existing.validity_date,
    terms: payload.terms ?? existing.terms,
    status: nextStatus,
    owner: payload.owner ?? existing.owner,
    notes: payload.notes ?? existing.notes,
    sent_channel: payload.sent_channel ?? existing.sent_channel,
    manual_sent_at: markSent ? nowIso() : existing.manual_sent_at,
    updated_by: changedBy ?? null,
    updated_at: nowIso(),
  };

  const { data: updated, error: updateError } = await supabase
    .from('inquiry_quotes')
    .update(patch)
    .eq('id', quoteId)
    .select('*')
    .single();

  if (updateError) throw updateError;

  const changedFields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) changedFields[key] = value;

  await supabase.from('inquiry_quote_events').insert({
    quote_id: quoteId,
    previous_status: existing.status,
    new_status: nextStatus,
    changed_fields: changedFields,
    changed_by: changedBy ?? null,
    note: markSent ? 'Quote marked as manually sent' : 'Quote updated',
  });

  return updated as InquiryQuote;
}
