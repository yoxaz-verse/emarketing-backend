import { AllowedTable } from '../config/allowedTables';
import { TABLE_FIELD_MAP } from '../config/tableFieldMap';
import { supabase } from '../supabase';
import { buildSelect } from '../utils/buildSelectQuery';
import { resolveAfterRead } from './domain/readResolvers';
import { transformForRead } from './fieldTransform';
import { normalizePagination, normalizeSortOrder } from '../utils/pagination';

type CrudAuthContext = {
  role?: string | null;
  operator_id?: string | null;
};

export type CrudPage<T = Record<string, unknown>> = {
  rows: T[];
  total: number;
  page: number;
  page_size: number;
};

const SEARCHABLE_COLUMNS: Partial<Record<AllowedTable, string[]>> = {
  leads: ['email', 'first_name', 'last_name', 'company', 'country', 'source'],
  campaigns: ['name', 'status'],
  operators: ['name', 'region'],
  inboxes: ['email_address', 'status'],
  sequences: ['name', 'status'],
  sequence_steps: ['subject', 'body'],
  users: ['email', 'role'],
  campaign_leads: ['status'],
  agents: ['name', 'status'],
};

function isAdmin(role: unknown) {
  const normalized = String(role ?? '').toLowerCase();
  return normalized === 'admin' || normalized === 'superadmin';
}

function requiresOperatorScope(table: AllowedTable) {
  return ['campaigns', 'campaign_leads', 'campaign_inboxes', 'leads', 'operators'].includes(table);
}

function httpError(message: string, statusCode: number) {
  return Object.assign(new Error(message), { statusCode });
}

function parseBoolean(value: unknown): boolean | null {
  if (value === true || value === 'true' || value === '1' || value === 1) return true;
  if (value === false || value === 'false' || value === '0' || value === 0) return false;
  return null;
}

function escapeSearch(value: unknown) {
  return String(value ?? '').trim().replace(/[,%()]/g, ' ');
}

export async function listRowsPage(
  table: AllowedTable,
  input: Record<string, unknown> = {},
  auth?: CrudAuthContext,
  options?: { maxPageSize?: number; includeCount?: boolean },
): Promise<CrudPage> {
  const { page, pageSize, offset } = normalizePagination(input.page, input.page_size, 25, options?.maxPageSize ?? 100);
  const fieldDefinitions = TABLE_FIELD_MAP[table] ?? {};
  const allowedColumns = new Set(Object.values(fieldDefinitions).map((field) => field.db));
  allowedColumns.add('id');

  const requestedSort = String(input.sort_by ?? '').trim();
  const defaultSort = allowedColumns.has('created_at') ? 'created_at' : 'id';
  const sortBy = allowedColumns.has(requestedSort) ? requestedSort : defaultSort;
  const ascending = normalizeSortOrder(input.sort_order) === 'asc';
  const operatorScoped = !isAdmin(auth?.role) && Boolean(String(auth?.operator_id ?? '').trim());
  const operatorId = String(auth?.operator_id ?? '').trim();

  if (!isAdmin(auth?.role) && !operatorId && requiresOperatorScope(table)) {
    throw httpError('Operator access required', 403);
  }

  let scopedCampaignIds: string[] | null = null;
  if (operatorScoped && (table === 'campaign_leads' || table === 'campaign_inboxes')) {
    const { data: campaignRows, error } = await supabase
      .from('campaigns')
      .select('id')
      .eq('operator_id', operatorId);
    if (error) throw error;
    scopedCampaignIds = (campaignRows ?? []).map((row: any) => String(row.id)).filter(Boolean);
  }

  const controlKeys = new Set(['page', 'page_size', 'q', 'sort_by', 'sort_order']);
  const q = escapeSearch(input.q);
  const searchColumns = (SEARCHABLE_COLUMNS[table] ?? []).filter((column) => allowedColumns.has(column));

  const executePageQuery = (excludeColumns: string[] = []) => {
    let query: any = supabase
      .from(table)
      .select(
        buildSelect(table, { excludeColumns }),
        options?.includeCount === false ? {} : { count: 'exact' },
      );

    if (operatorScoped) {
      if (table === 'campaigns' || table === 'leads') query = query.eq('operator_id', operatorId);
      if (table === 'operators') query = query.eq('id', operatorId);
      if (table === 'campaign_leads' || table === 'campaign_inboxes') {
        query = scopedCampaignIds && scopedCampaignIds.length > 0
          ? query.in('campaign_id', scopedCampaignIds)
          : query.eq('campaign_id', '__no_operator_campaign__');
      }
    }

    for (const [key, rawValue] of Object.entries(input)) {
      if (controlKeys.has(key) || rawValue === '' || rawValue === null || rawValue === undefined) continue;
      const alias = table === 'leads' && key === 'status'
        ? 'lead_status'
        : table === 'leads' && key === 'eligibility'
          ? 'email_eligibility'
          : key;
      if (!allowedColumns.has(alias)) continue;
      if (operatorScoped && alias === 'operator_id') continue;
      const boolValue = parseBoolean(rawValue);
      query = query.eq(alias, boolValue === null ? rawValue : boolValue);
    }

    if (q && searchColumns.length > 0) {
      query = query.or(searchColumns.map((column) => `${column}.ilike.%${q}%`).join(','));
    }

    return query
      .order(sortBy, { ascending, nullsFirst: !ascending })
      .range(offset, offset + pageSize - 1);
  };

  let { data, error, count } = await executePageQuery();
  if (
    error &&
    table === 'campaigns' &&
    String(error.code ?? '') === '42703' &&
    String(error.message ?? '').includes('sender_display_name')
  ) {
    ({ data, error, count } = await executePageQuery(['sender_display_name']));
  }
  if (error) throw error;

  const transformed = (data ?? []).map((row: Record<string, unknown>) => transformForRead(table, row));
  const rows = await resolveAfterRead(table, transformed);
  return {
    rows,
    total: Number(count ?? 0),
    page,
    page_size: pageSize,
  };
}
