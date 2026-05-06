import { TABLE_FIELD_MAP } from "../config/tableFieldMap";

export function buildSelect(table: string) {
  const fields = TABLE_FIELD_MAP[table];
  if (!fields) return '*';

  const base: string[] = [];
  const relations: string[] = [];

  const leadOptionalColumns = new Set([
    'validation_status',
    'disposable',
    'role_based',
    'free_provider',
    'risk_score',
    'suggestion',
    'mx_records',
    'provider',
  ]);

  const includeLeadOptionalColumns =
    process.env.ENABLE_LEAD_VALIDATION_COLUMNS === 'true';

  for (const [key, def] of Object.entries(fields)) {
    if (
      table === 'leads' &&
      leadOptionalColumns.has(def.db) &&
      !includeLeadOptionalColumns
    ) {
      continue;
    }

    // always select base column
    base.push(def.db);

    if (def.behavior === 'relation' && def.relation) {
      const { table, valueKey, labelKey } = def.relation;

      relations.push(
        `${table} (${valueKey}, ${labelKey})`
      );
    }
  }

  const select = [...base, ...relations].join(',');
  console.log(`[DEBUG] Building SELECT for table "${table}": ${select}`);
  return select;
}
