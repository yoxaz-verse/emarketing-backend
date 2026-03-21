// src/services/crudService.ts
import { AllowedTable } from '../config/allowedTables';
import { supabase } from '../supabase';
import { buildSelect } from '../utils/buildSelectQuery';
import { resolveAfterRead } from './domain/readResolvers';
import { runBeforeDelete } from './domain/runBeforeDelete';
import { runBeforeWrite } from './domain/runBeforeWrite';
import { transformForWrite, transformForRead } from './fieldTransform';
type DbRow = Record<string, unknown>;

export async function listRows(
  table: AllowedTable,
  filters: Record<string, any> = {}
) {
  const applyFilters = (baseQuery: ReturnType<typeof supabase.from>) => {
    let nextQuery = baseQuery;
    for (const [key, value] of Object.entries(filters)) {
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
  if (error) throw error;

  const rows = (data ?? []).map((row: Record<string, unknown>) =>
    transformForRead(table, row)
  );


  // ✅ DOMAIN-SAFE EXTENSION POINT
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

  if (error) throw error;
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

  if (error) throw error;
}

export async function deleteRow(
  table: AllowedTable,
  id: string
) {
  // 🔥 lifecycle first
  await runBeforeDelete(table, id);

  const { error } = await supabase
    .from(table)
    .delete()
    .eq('id', id);

  if (error) throw error;
}
