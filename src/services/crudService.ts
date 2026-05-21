// src/services/crudService.ts
import { AllowedTable } from '../config/allowedTables';
import { supabase } from '../supabase';
import { buildSelect } from '../utils/buildSelectQuery';
import { resolveAfterRead } from './domain/readResolvers';
import { runBeforeDelete } from './domain/runBeforeDelete';
import { runBeforeWrite } from './domain/runBeforeWrite';
import { transformForWrite, transformForRead } from './fieldTransform';
type DbRow = Record<string, unknown>;
type CrudAuthContext = {
  role?: string | null;
  operator_id?: string | null;
  user_id?: string | null;
};

function isAdminRole(role?: string | null): boolean {
  const normalized = String(role ?? '').toLowerCase();
  return normalized === 'admin' || normalized === 'superadmin';
}

function isOperatorScopedUser(auth?: CrudAuthContext): boolean {
  const isAdmin = isAdminRole(auth?.role);
  const hasOperatorId = String(auth?.operator_id ?? '').trim().length > 0;
  return !isAdmin && hasOperatorId;
}

function requiresOperatorScope(table: AllowedTable): boolean {
  return table === 'campaigns' || table === 'campaign_leads' || table === 'campaign_inboxes' || table === 'leads' || table === 'operators';
}

function createHttpError(message: string, statusCode: number): Error & { statusCode: number } {
  const err = new Error(message) as Error & { statusCode: number };
  err.statusCode = statusCode;
  return err;
}

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

function mapCrudDeleteError(table: AllowedTable, error: any): Error {
  const code = String(error?.code ?? '');
  const message = String(error?.message ?? 'Delete failed');
  const details = String(error?.details ?? '');

  if (table === 'campaigns' && code === '23503') {
    return createHttpError(
      'Campaign cannot be deleted due to dependent records. Remove related records and retry.',
      409
    );
  }

  if (code === '42501') {
    return createHttpError('Permission denied for delete operation.', 403);
  }

  if (code === '23503') {
    return createHttpError(`Delete blocked by dependency constraint. ${message || details}`.trim(), 409);
  }

  if (code === '22P02') {
    return createHttpError('Invalid id format for delete operation.', 400);
  }

  return createHttpError(message, 400);
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
  filters: Record<string, any> = {},
  auth?: CrudAuthContext
) {
  const sanitized = normalizeFilters(filters);
  const isSequencesTable = table === 'sequences';

  if (isSequencesTable) {
    console.info('[CRUD_LIST_SEQUENCES_INPUT]', {
      filters: sanitized,
    });
  }

  const applyFilters = async (baseQuery: ReturnType<typeof supabase.from>) => {
    let nextQuery: any = baseQuery;
    const operatorScoped = isOperatorScopedUser(auth);
    const isAdmin = isAdminRole(auth?.role);
    const operatorId = String(auth?.operator_id ?? '').trim();

    if (!isAdmin && !operatorId && requiresOperatorScope(table)) {
      throw createHttpError('Operator access required', 403);
    }

    if (operatorScoped) {
      if (table === 'campaigns' || table === 'leads') {
        nextQuery = nextQuery.eq('operator_id', operatorId);
      }
      if (table === 'operators') {
        nextQuery = nextQuery.eq('id', operatorId);
      }

      if (table === 'campaign_leads' || table === 'campaign_inboxes') {
        const { data: campaignRows, error: campaignError } = await supabase
          .from('campaigns')
          .select('id')
          .eq('operator_id', operatorId);
        if (campaignError) throw campaignError;
        const allowedCampaignIds = (campaignRows ?? []).map((row: any) => String(row.id)).filter(Boolean);
        if (allowedCampaignIds.length === 0) {
          nextQuery = nextQuery.eq('campaign_id', '__no_operator_campaign__');
        } else {
          nextQuery = nextQuery.in('campaign_id', allowedCampaignIds);
        }
      }
    }

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

      if (operatorScoped) {
        nextQuery = nextQuery.eq('operator_id', operatorId);
      } else if (operator_id) {
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

      const normalizedBool = parseBoolean(value);
      const normalizedValue = normalizedBool === null ? value : normalizedBool;
      nextQuery = nextQuery.eq(key, normalizedValue);
    }
    return nextQuery;
  };

  const select = buildSelect(table);
  let query = await applyFilters(supabase.from(table).select(select));

  let { data, error } = await query;
  if (isSequencesTable) {
    console.info('[CRUD_LIST_SEQUENCES_QUERY_RESULT]', {
      phase: 'primary_select',
      errorCode: String(error?.code ?? ''),
      errorMessage: String(error?.message ?? ''),
      rowCount: Array.isArray(data) ? data.length : 0,
    });
  }
  if (
    error &&
    (
      error.code === 'PGRST205' ||
      error.code === '42P01' ||
      error.message?.includes('Could not find the table') ||
      error.message?.toLowerCase().includes('does not exist')
    )
  ) {
    console.warn(`[CRUD LIST WARNING] Table ${table} missing in schema. Return [].`);
    return [];
  }
  if (error && error.code === '42703' && table === 'sequences') {
    console.warn('[CRUD LIST WARNING] Missing column in sequences, falling back to *', error);
    query = await applyFilters(supabase.from(table).select('*'));
    ({ data, error } = await query);
    if (isSequencesTable) {
      console.info('[CRUD_LIST_SEQUENCES_QUERY_RESULT]', {
        phase: 'fallback_select_star',
        errorCode: String(error?.code ?? ''),
        errorMessage: String(error?.message ?? ''),
        rowCount: Array.isArray(data) ? data.length : 0,
      });
    }
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
    query = await applyFilters(
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

    query = await applyFilters(
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

  if (isSequencesTable) {
    console.info('[CRUD_LIST_SEQUENCES_OUTPUT]', {
      rowCount: rows.length,
    });
  }

  return await resolveAfterRead(table, rows);
}

export async function insertRow(
  table: AllowedTable,
  payload: Record<string, any>,
  auth?: CrudAuthContext
) {
  const operatorScoped = isOperatorScopedUser(auth);
  const isAdmin = isAdminRole(auth?.role);
  const operatorId = String(auth?.operator_id ?? '').trim();
  if (!isAdmin && !operatorId && requiresOperatorScope(table)) {
    throw createHttpError('Operator access required', 403);
  }

  if (operatorScoped && table === 'sequences') {
    throw createHttpError('Only admin can modify sequences', 403);
  }
  if (operatorScoped && table === 'sequence_steps') {
    throw createHttpError('Only admin can modify sequence steps', 403);
  }
  if (operatorScoped && table === 'campaigns') {
    payload = { ...payload, operator_id: operatorId };
  }
  if (operatorScoped && table === 'leads') {
    payload = { ...payload, operator_id: operatorId };
  }

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
  payload: Record<string, any>,
  auth?: CrudAuthContext
) {
  const operatorScoped = isOperatorScopedUser(auth);
  const isAdmin = isAdminRole(auth?.role);
  const operatorId = String(auth?.operator_id ?? '').trim();
  if (!isAdmin && !operatorId && requiresOperatorScope(table)) {
    throw createHttpError('Operator access required', 403);
  }
  if (operatorScoped && (table === 'sequences' || table === 'sequence_steps')) {
    throw createHttpError('Only admin can modify sequences', 403);
  }
  if (operatorScoped && table === 'campaigns') {
    const { data: row, error } = await supabase.from('campaigns').select('id,operator_id').eq('id', id).maybeSingle();
    if (error) throw error;
    if (!row || String(row.operator_id ?? '') !== operatorId) throw createHttpError('Campaign not found', 404);
    payload = { ...payload, operator_id: operatorId };
  }
  if (operatorScoped && table === 'leads') {
    const { data: row, error } = await supabase.from('leads').select('id,operator_id').eq('id', id).maybeSingle();
    if (error) throw error;
    if (!row || String(row.operator_id ?? '') !== operatorId) throw createHttpError('Lead not found', 404);
    payload = { ...payload, operator_id: operatorId };
  }
  if (operatorScoped && table === 'campaign_leads') {
    const { data: row, error } = await supabase
      .from('campaign_leads')
      .select('id,campaign_id,campaigns!inner(operator_id)')
      .eq('id', id)
      .maybeSingle();
    if (error) throw error;
    const rowOperatorId = String((row as any)?.campaigns?.operator_id ?? '');
    if (!row || rowOperatorId !== operatorId) throw createHttpError('Campaign lead not found', 404);
  }

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
  id: string,
  auth?: CrudAuthContext
) {
  const operatorScoped = isOperatorScopedUser(auth);
  const isAdmin = isAdminRole(auth?.role);
  const operatorId = String(auth?.operator_id ?? '').trim();
  if (!isAdmin && !operatorId && requiresOperatorScope(table)) {
    throw createHttpError('Operator access required', 403);
  }
  if (operatorScoped && (table === 'sequences' || table === 'sequence_steps')) {
    throw createHttpError('Only admin can modify sequences', 403);
  }
  if (operatorScoped && table === 'campaigns') {
    const { data: row, error } = await supabase.from('campaigns').select('id,operator_id').eq('id', id).maybeSingle();
    if (error) throw error;
    if (!row || String(row.operator_id ?? '') !== operatorId) throw createHttpError('Campaign not found', 404);
  }
  if (operatorScoped && table === 'leads') {
    const { data: row, error } = await supabase.from('leads').select('id,operator_id').eq('id', id).maybeSingle();
    if (error) throw error;
    if (!row || String(row.operator_id ?? '') !== operatorId) throw createHttpError('Lead not found', 404);
  }
  if (operatorScoped && table === 'campaign_leads') {
    const { data: row, error } = await supabase
      .from('campaign_leads')
      .select('id,campaigns!inner(operator_id)')
      .eq('id', id)
      .maybeSingle();
    if (error) throw error;
    const rowOperatorId = String((row as any)?.campaigns?.operator_id ?? '');
    if (!row || rowOperatorId !== operatorId) throw createHttpError('Campaign lead not found', 404);
  }

  await runBeforeDelete(table, id);

  const { error } = await supabase
    .from(table)
    .delete()
    .eq('id', id);

  if (error) throw mapCrudDeleteError(table, error);
}

export async function deleteRowsBulk(
  table: AllowedTable,
  ids: string[],
  auth?: CrudAuthContext
) {
  const operatorScoped = isOperatorScopedUser(auth);
  const isAdmin = isAdminRole(auth?.role);
  const operatorId = String(auth?.operator_id ?? '').trim();
  if (!isAdmin && !operatorId && requiresOperatorScope(table)) {
    throw createHttpError('Operator access required', 403);
  }
  if (operatorScoped && (table === 'sequences' || table === 'sequence_steps')) {
    throw createHttpError('Only admin can modify sequences', 403);
  }

  const uniqueIds = Array.from(new Set((ids ?? []).filter((id): id is string => typeof id === 'string' && id.trim().length > 0)));
  if (uniqueIds.length === 0) {
    return { deletedCount: 0, requestedCount: 0, filteredCount: 0 };
  }

  let existingQuery: any = supabase
    .from(table)
    .select('id')
    .in('id', uniqueIds);

  if (operatorScoped) {
    if (!operatorId && (table === 'campaigns' || table === 'campaign_leads' || table === 'leads')) {
      throw createHttpError('Operator access required', 403);
    }
    if (table === 'campaigns' || table === 'leads') {
      existingQuery = existingQuery.eq('operator_id', operatorId);
    }
    if (table === 'campaign_leads') {
      const { data: campaignRows, error: campaignError } = await supabase
        .from('campaigns')
        .select('id')
        .eq('operator_id', operatorId);
      if (campaignError) throw campaignError;
      const allowedCampaignIds = (campaignRows ?? []).map((row: any) => String(row.id)).filter(Boolean);
      if (allowedCampaignIds.length === 0) {
        return { deletedCount: 0, requestedCount: uniqueIds.length, filteredCount: uniqueIds.length };
      }
      existingQuery = existingQuery.in('campaign_id', allowedCampaignIds);
    }
  }

  const { data: existingRows, error: fetchError } = await existingQuery;

  if (fetchError) throw fetchError;
  const existingIds = (existingRows ?? []).map((row: any) => row.id).filter(Boolean);

  if (existingIds.length === 0) {
    return { deletedCount: 0, requestedCount: uniqueIds.length, filteredCount: uniqueIds.length };
  }

  const { error } = await supabase
    .from(table)
    .delete()
    .in('id', existingIds);

  if (error) throw error;
  return {
    deletedCount: existingIds.length,
    requestedCount: uniqueIds.length,
    filteredCount: Math.max(0, uniqueIds.length - existingIds.length),
  };
}
