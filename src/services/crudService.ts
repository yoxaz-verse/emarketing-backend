// src/services/crudService.ts
import { AllowedTable } from '../config/allowedTables';
import { supabase } from '../supabase';
import { buildSelect } from '../utils/buildSelectQuery';
import { resolveAfterRead } from './domain/readResolvers';
import { runBeforeDelete } from './domain/runBeforeDelete';
import { runBeforeWrite } from './domain/runBeforeWrite';
import { transformForWrite, transformForRead } from './fieldTransform';
type DbRow = Record<string, unknown>;

function mapCrudWriteError(table: AllowedTable, error: any): Error {
  const code = String(error?.code ?? '');
  const message = String(error?.message ?? 'Write failed');
  const details = String(error?.details ?? '');

  if (
    table === 'inboxes' &&
    code === '23505' &&
    (message.includes('inboxes_email_address_unique_idx') || details.includes('email_address'))
  ) {
    return new Error('Inbox email already exists. Please use a unique email address.');
  }

  return new Error(message);
}

function parseBoolean(value: unknown): boolean | null {
  if (value === true || value === 'true' || value === '1' || value === 1) return true;
  if (value === false || value === 'false' || value === '0' || value === 0) return false;
  return null;
}

function normalizeFilters(filters: Record<string, any>): Record<string, any> {
  const out = { ...filters };
  for (const key of Object.keys(out)) {
    if (out[key] === undefined || out[key] === null || out[key] === '') {
      delete out[key];
    }
  }
  return out;
}

function isLeadsRelationCacheError(error: any): boolean {
  const code = String(error?.code ?? '');
  const message = String(error?.message ?? '');
  return (
    code === 'PGRST200' ||
    message.includes("Could not find a relationship between 'leads' and 'lead_folders'") ||
    message.includes("Could not find a relationship between 'leads' and 'operators'") ||
    message.includes("schema cache")
  );
}

const enableLeadValidationColumns = process.env.ENABLE_LEAD_VALIDATION_COLUMNS === 'true';

function isMissingInboxesWarmupColumns(error: any): boolean {
  const code = String(error?.code ?? '');
  const message = String(error?.message ?? '');
  return (
    code === '42703' &&
    (
      message.includes('column inboxes.warmup_enabled') ||
      message.includes('column inboxes.warmup_day')
    )
  );
}

function applyLegacyInboxWarmupDefaults(row: Record<string, unknown>): Record<string, unknown> {
  return {
    ...row,
    warmup_enabled: typeof row.warmup_enabled === 'boolean' ? row.warmup_enabled : false,
    warmup_day: Number.isFinite(Number(row.warmup_day)) ? Number(row.warmup_day) : 1,
  };
}

export async function listRows(
  table: AllowedTable,
  filters: Record<string, any> = {}
) {
  const sanitized = normalizeFilters(filters);

  const applyFilters = (baseQuery: ReturnType<typeof supabase.from>) => {
    let nextQuery: any = baseQuery;

    if (table === 'leads') {
      const {
        sortBy,
        sortOrder,
        page,
        pageSize,
        q,
        status,
        eligibility,
        validationStatus,
        riskMin,
        riskMax,
        isUsed,
        isBlocked,
        provider,
        source,
        operator_id,
        fromDate,
        toDate,
      } = sanitized;

      if (operator_id) {
        nextQuery = nextQuery.eq('operator_id', operator_id);
      }

      if (status) {
        nextQuery = nextQuery.eq('lead_status', status);
      }

      if (eligibility) {
        nextQuery = nextQuery.eq('email_eligibility', eligibility);
      }

      if (enableLeadValidationColumns && validationStatus) {
        nextQuery = nextQuery.eq('validation_status', validationStatus);
      }

      if (enableLeadValidationColumns && provider) {
        nextQuery = nextQuery.eq('provider', provider);
      }

      if (source) {
        nextQuery = nextQuery.eq('source', source);
      }

      if (enableLeadValidationColumns && riskMin !== undefined) {
        const min = Number(riskMin);
        if (!Number.isNaN(min)) nextQuery = nextQuery.gte('risk_score', min);
      }

      if (enableLeadValidationColumns && riskMax !== undefined) {
        const max = Number(riskMax);
        if (!Number.isNaN(max)) nextQuery = nextQuery.lte('risk_score', max);
      }

      if (fromDate) {
        nextQuery = nextQuery.gte('created_at', fromDate);
      }

      if (toDate) {
        nextQuery = nextQuery.lte('created_at', toDate);
      }

      const sortField = typeof sortBy === 'string' ? sortBy : 'created_at';
      const ascending = String(sortOrder ?? 'desc').toLowerCase() === 'asc';
      nextQuery = nextQuery.order(sortField, { ascending, nullsFirst: !ascending });

      if (pageSize) {
        const safePageSize = Math.max(1, Math.min(500, Number(pageSize) || 50));
        const safePage = Math.max(1, Number(page) || 1);
        const from = (safePage - 1) * safePageSize;
        const to = from + safePageSize - 1;
        nextQuery = nextQuery.range(from, to);
      }

      if (q) {
        const term = String(q).replace(/[,]/g, '');
        nextQuery = nextQuery.or(
          `email.ilike.%${term}%,first_name.ilike.%${term}%,company.ilike.%${term}%,country.ilike.%${term}%`
        );
      }      const blockedFlag = parseBoolean(isBlocked);
      if (blockedFlag === true) {
        nextQuery = nextQuery.or('email_eligibility.eq.blocked,permanently_failed.eq.true');
      }
    }

    for (const [key, value] of Object.entries(sanitized)) {
      if (
        [
          'sortBy',
          'sortOrder',
          'page',
          'pageSize',
          'q',
          'status',
          'eligibility',
          'validationStatus',
          'riskMin',
          'riskMax',
          'isUsed',
          'isBlocked',
          'provider',
          'source',
          'fromDate',
          'toDate',
        ].includes(key)
      ) {
        continue;
      }

      nextQuery = nextQuery.eq(key, value);
    }
    return nextQuery;
  };

  const select = buildSelect(table);
  let query = applyFilters(supabase.from(table).select(select));

  let { data, error } = await query;
  if (error && (error.code === 'PGRST205' || error.message?.includes('Could not find the table'))) {
    console.warn(`[CRUD LIST WARNING] Table ${table} missing in schema. Return [].`);
    return [];
  }
  if (error && error.code === '42703' && table === 'sequences') {
    console.warn('[CRUD LIST WARNING] Missing column in sequences, falling back to *', error);
    query = applyFilters(supabase.from(table).select('*'));
    ({ data, error } = await query);
  }
  if (
    error &&
    table === 'leads' &&
    (
      error.code === '42703' ||
      error.message?.includes('column leads.') ||
      isLeadsRelationCacheError(error)
    )
  ) {
    console.warn('[CRUD_LIST_LEADS_FALLBACK_NON_RELATION]', {
      reasonCode: String(error?.code ?? ''),
      reasonMessage: String(error?.message ?? ''),
      selectMode: 'non_relation',
    });
    query = applyFilters(
      supabase.from(table).select(buildSelect('leads', { includeRelations: false }))
    );
    ({ data, error } = await query);
  }
  if (
    error &&
    table === 'inboxes' &&
    isMissingInboxesWarmupColumns(error)
  ) {
    console.warn('[CRUD_LIST_INBOXES_FALLBACK_LEGACY_WARMUP_COLUMNS]', {
      reasonCode: String(error?.code ?? ''),
      reasonMessage: String(error?.message ?? ''),
      selectMode: 'exclude_warmup_columns',
    });

    query = applyFilters(
      supabase.from(table).select(buildSelect('inboxes', {
        excludeColumns: ['warmup_enabled', 'warmup_day'],
      }))
    );

    ({ data, error } = await query);

    if (!error) {
      data = (data ?? []).map((row: Record<string, unknown>) =>
        applyLegacyInboxWarmupDefaults(row)
      );
    }
  }

  if (error) throw error;

  const rows = (data ?? []).map((row: Record<string, unknown>) =>
    transformForRead(table, row)
  );

  return await resolveAfterRead(table, rows);
}

export async function insertRow(
  table: AllowedTable,
  payload: Record<string, any>
) {

  payload = await runBeforeWrite(table, payload, 'create');
  const data = await transformForWrite(table, payload);

  console.log('[INSERT DATA]', table, data);

  const { error } = await supabase
    .from(table)
    .insert(data);

  if (error) throw mapCrudWriteError(table, error);
}

export async function updateRow(
  table: AllowedTable,
  id: string,
  payload: Record<string, any>
) {
  payload = await runBeforeWrite(table, payload, 'update', id);
  const data = await transformForWrite(table, payload);
  console.log('[Update DATA]', table, data);

  const { error } = await supabase
    .from(table)
    .update(data)
    .eq('id', id);

  if (error) throw mapCrudWriteError(table, error);
}

export async function deleteRow(
  table: AllowedTable,
  id: string
) {
  await runBeforeDelete(table, id);

  const { error } = await supabase
    .from(table)
    .delete()
    .eq('id', id);

  if (error) throw error;
}

export async function deleteRowsBulk(
  table: AllowedTable,
  ids: string[]
) {
  const uniqueIds = Array.from(new Set((ids ?? []).filter((id): id is string => typeof id === 'string' && id.trim().length > 0)));
  if (uniqueIds.length === 0) {
    return { deletedCount: 0 };
  }

  const { data: existingRows, error: fetchError } = await supabase
    .from(table)
    .select('id')
    .in('id', uniqueIds);

  if (fetchError) throw fetchError;
  const existingIds = (existingRows ?? []).map((row: any) => row.id).filter(Boolean);

  if (existingIds.length === 0) {
    return { deletedCount: 0 };
  }

  const { error } = await supabase
    .from(table)
    .delete()
    .in('id', existingIds);

  if (error) throw error;
  return { deletedCount: existingIds.length };
}
