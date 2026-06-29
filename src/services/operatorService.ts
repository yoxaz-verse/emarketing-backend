import { supabase } from '../supabase.js';

type UploadRow = Record<string, any>;

type UploadInput = {
  fileType?: 'csv' | 'xlsx';
  mapping?: Record<
    string,
    | string
    | {
        mode: 'combine';
        columns: string[];
        separator?: ',' | ' ' | '\n';
      }
  >;
  rows?: UploadRow[];
  leads?: UploadRow[];
  source?: string;
  tags?: string[];
  duplicate_mode?: 'skip' | 'replace';
};

type InvalidRow = {
  index: number;
  reason: string;
  row: UploadRow;
};

type UploadReport = {
  success: boolean;
  insertedCount: number;
  replacedCount?: number;
  duplicateCount: number;
  invalidCount: number;
  duplicateEmails: string[];
  invalidRows: InvalidRow[];
  warnings?: string[];
  skippedFields?: string[];
};

const SUPPORTED_FIELDS = [
  'email',
  'first_name',
  'last_name',
  'company',
  'job_title',
  'country',
  'phone',
  'linkedin_url',
  'website',
  'company_description',
  'industry',
  'employee_size',
  'source',
  'tags',
  'notes',
] as const;

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function mapRowWithMapping(
  row: UploadRow,
  mapping?: Record<
    string,
    | string
    | {
        mode: 'combine';
        columns: string[];
        separator?: ',' | ' ' | '\n';
      }
  >
): UploadRow {
  if (!mapping || Object.keys(mapping).length === 0) return row;

  const out: UploadRow = {};
  for (const [targetField, rule] of Object.entries(mapping)) {
    if (!rule) continue;

    if (typeof rule === 'string') {
      out[targetField] = row[rule];
      continue;
    }

    if (rule.mode === 'combine') {
      const separator = rule.separator ?? ',';
      const parts = (rule.columns ?? [])
        .map((col) => row[col])
        .map((value) => (value == null ? '' : String(value).trim()))
        .filter(Boolean);

      out[targetField] = parts.join(separator);
    }
  }
  return out;
}

function normalizeTags(value: unknown): string[] | null {
  if (!value) return null;
  if (Array.isArray(value)) {
    const arr = value.map((v) => String(v).trim()).filter(Boolean);
    return arr.length ? arr : null;
  }
  const arr = String(value)
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
  return arr.length ? arr : null;
}

function buildInsertRow(row: UploadRow, operatorId: string | null, defaultSource?: string, defaultTags?: string[]) {
  const email = String(row.email ?? '').trim();

  const base: Record<string, any> = {
    email,
    first_name: row.first_name ? String(row.first_name).trim() : null,
    company: row.company ? String(row.company).trim() : null,
    operator_id: operatorId,
    status: 'pending',
    email_eligibility: 'pending',
    email_eligibility_reason: null,
    eligibility_processing: false,
    retry_count: 0,
    permanently_failed: false,
    is_suppressed: false,
    suppression_reason: null,
    suppressed_at: null,
    lead_status: 'pending_validation',
  };

  for (const field of SUPPORTED_FIELDS) {
    if (field in base) continue;
    if (field === 'tags') {
      base.tags = normalizeTags(row.tags) ?? defaultTags ?? null;
      continue;
    }

    const candidate = row[field] ?? (field === 'source' ? defaultSource : undefined);
    base[field] = candidate == null || candidate === '' ? null : String(candidate).trim();
  }

  return base;
}

function isMissingColumnError(error: any): boolean {
  const msg = String(error?.message ?? '').toLowerCase();
  const code = String(error?.code ?? '');
  // PGRST204 is the PostgREST error code for "Could not find the column in the schema cache"
  return code === '42703' || code === 'PGRST204' || msg.includes('column') || msg.includes('schema cache');
}

function extractMissingColumn(error: any): string | null {
  const msg = String(error?.message ?? '');
  const patterns = [
    /column\s+["']?([a-zA-Z0-9_]+)["']?\s+does not exist/i,
    /Could not find the ['"]?([a-zA-Z0-9_]+)['"]?\s+column/i,
    /column\s+['"]?([a-zA-Z0-9_]+)['"]?\s+of/i,
  ];

  for (const pattern of patterns) {
    const match = msg.match(pattern);
    if (match?.[1]) return match[1];
  }
  return null;
}

function sanitizeRowsForColumns(
  rows: Record<string, any>[],
  allowed: Set<string>
): Record<string, any>[] {
  return rows.map((row) => {
    const next: Record<string, any> = {};
    for (const key of Object.keys(row)) {
      if (allowed.has(key)) next[key] = row[key];
    }
    return next;
  });
}

async function insertWithSchemaFallback(
  rowsToInsert: Record<string, any>[]
): Promise<{ insertedCount: number; warnings: string[]; skippedFields: string[] }> {
  if (rowsToInsert.length === 0) {
    return { insertedCount: 0, warnings: [], skippedFields: [] };
  }

  const warnings: string[] = [];
  const skippedFields = new Set<string>();
  const coreFields = new Set([
    'email',
    'first_name',
    'company',
    'operator_id',
    'email_eligibility',
    'email_eligibility_reason',
    'eligibility_processing',
    'retry_count',
    'permanently_failed',
    'is_suppressed',
    'suppression_reason',
    'suppressed_at',
  ]);

  let allowedFields = new Set(Object.keys(rowsToInsert[0] ?? {}));
  let candidateRows = rowsToInsert;

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const { error } = await supabase.from('leads').insert(candidateRows);
    if (!error) {
      return {
        insertedCount: candidateRows.length,
        warnings,
        skippedFields: Array.from(skippedFields),
      };
    }

    if (!isMissingColumnError(error)) {
      throw error;
    }

    const missing = extractMissingColumn(error);
    if (!missing || !allowedFields.has(missing) || coreFields.has(missing)) {
      warnings.push(`Import fallback attempted but failed: ${String(error.message ?? 'Unknown schema error')}`);
      throw error;
    }

    allowedFields.delete(missing);
    skippedFields.add(missing);
    candidateRows = sanitizeRowsForColumns(rowsToInsert, allowedFields);
    warnings.push(`Skipped missing DB column "${missing}" and retried import.`);
  }

  throw new Error('Import fallback exceeded retry limit');
}

export async function uploadLeads(
  operatorId: string | null,
  input: UploadInput
): Promise<UploadReport> {
  const duplicateMode = input.duplicate_mode ?? 'skip';
  if (duplicateMode !== 'skip' && duplicateMode !== 'replace') {
    throw new Error('Invalid duplicate_mode. Allowed values: skip | replace');
  }

  const rows = (input.rows ?? input.leads ?? []) as UploadRow[];

  if (!rows.length) {
    throw new Error('No rows provided for import');
  }

  const invalidRows: InvalidRow[] = [];
  const duplicateEmails: string[] = [];
  const dedupeSet = new Set<string>();
  const preparedRows: Record<string, any>[] = [];

  const mappedRows = rows.map((row) => mapRowWithMapping(row, input.mapping));

  for (let i = 0; i < mappedRows.length; i += 1) {
    const row = mappedRows[i];
    const emailRaw = String(row.email ?? '').trim();

    if (!emailRaw) {
      invalidRows.push({ index: i, reason: 'Missing required field: email', row });
      continue;
    }

    const email = normalizeEmail(emailRaw);
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    if (!emailRegex.test(email)) {
      invalidRows.push({ index: i, reason: 'Invalid email format', row });
      continue;
    }

    if (dedupeSet.has(email)) {
      duplicateEmails.push(email);
      continue;
    }

    dedupeSet.add(email);
    preparedRows.push(buildInsertRow({ ...row, email }, operatorId, input.source, input.tags));
  }

  if (preparedRows.length === 0) {
    return {
      success: true,
      insertedCount: 0,
      replacedCount: 0,
      duplicateCount: duplicateEmails.length,
      invalidCount: invalidRows.length,
      duplicateEmails,
      invalidRows,
    };
  }

  const incomingEmails = preparedRows.map((row) => normalizeEmail(String(row.email)));
  let existsQuery = supabase
    .from('leads')
    .select('id,email')
    .in('email', incomingEmails);

  if (operatorId) {
    existsQuery = existsQuery.eq('operator_id', operatorId);
  }

  const { data: existingRows, error: existingError } = await existsQuery;
  if (existingError) throw existingError;

  const existingByEmail = new Map<string, { id: string; email: string }>();
  for (const row of existingRows ?? []) {
    const normalized = normalizeEmail(String((row as any).email ?? ''));
    const id = String((row as any).id ?? '');
    if (normalized && id) {
      existingByEmail.set(normalized, { id, email: String((row as any).email ?? '') });
    }
  }

  const rowsToInsert: Record<string, any>[] = [];
  const rowsToReplace: Array<{ id: string; update: Record<string, any>; email: string }> = [];

  for (const row of preparedRows) {
    const normalized = normalizeEmail(String(row.email ?? ''));
    const existing = existingByEmail.get(normalized);
    if (!existing) {
      rowsToInsert.push(row);
      continue;
    }

    duplicateEmails.push(normalized);
    if (duplicateMode !== 'replace') {
      continue;
    }

    const updatePayload: Record<string, any> = {};
    for (const [key, value] of Object.entries(row)) {
      if (
        key === 'id' ||
        key === 'created_at' ||
        key === 'operator_id' ||
        key === 'email' ||
        key === 'is_suppressed' ||
        key === 'suppression_reason' ||
        key === 'suppressed_at'
      ) continue;
      if (value === null || value === undefined) continue;
      if (typeof value === 'string' && value.trim() === '') continue;
      updatePayload[key] = value;
    }

    if (Object.keys(updatePayload).length > 0) {
      rowsToReplace.push({ id: existing.id, update: updatePayload, email: normalized });
    }
  }

  const insertResult = await insertWithSchemaFallback(rowsToInsert);
  let replacedCount = 0;

  if (duplicateMode === 'replace' && rowsToReplace.length > 0) {
    for (const row of rowsToReplace) {
      const { error: updateError } = await supabase
        .from('leads')
        .update(row.update)
        .eq('id', row.id);
      if (updateError) throw updateError;
      replacedCount += 1;
    }
  }

  return {
    success: true,
    insertedCount: insertResult.insertedCount,
    replacedCount,
    duplicateCount: duplicateEmails.length,
    invalidCount: invalidRows.length,
    duplicateEmails,
    invalidRows,
    warnings: insertResult.warnings,
    skippedFields: insertResult.skippedFields,
  };
}

export async function assignSequence(
  operatorId: string | null,
  sequenceId: string
) {
  const { data: leads } = await supabase
    .from('leads')
    .select('id')
    .eq('operator_id', operatorId)
    .eq('status', 'pending');

  if (!leads || leads.length === 0) return;

  const rows = (leads as Array<{ id: string }>).map((l) => ({
    lead_id: l.id,
    sequence_id: sequenceId,
    operator_id: operatorId,
    campaign_status: 'draft'
  }));

  await supabase.from('lead_sequences').insert(rows);
}

export async function startCampaign(operatorId: string | null) {
  await supabase
    .from('lead_sequences')
    .update({ campaign_status: 'running' })
    .eq('operator_id', operatorId)
    .eq('campaign_status', 'draft');
}

export async function pauseCampaign(operatorId: string | null) {
  await supabase
    .from('lead_sequences')
    .update({ campaign_status: 'paused' })
    .eq('operator_id', operatorId)
    .eq('campaign_status', 'running');
}

export async function resumeCampaign(operatorId: string | null) {
  await supabase
    .from('lead_sequences')
    .update({ campaign_status: 'running' })
    .eq('operator_id', operatorId)
    .eq('campaign_status', 'paused');
}
