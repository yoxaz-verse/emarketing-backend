import { hashPassword } from '../utils/password';
import { TABLE_FIELD_MAP } from '../config/tableFieldMap';
import { AllowedTable } from '../config/allowedTables';

export async function transformForWrite(
  table: AllowedTable,
  payload: Record<string, any>
) {
  const fields = TABLE_FIELD_MAP[table];
  const result: Record<string, any> = {};

  for (const [apiKey, field] of Object.entries(fields)) {
    // lifecycle may have added this
    if (!(apiKey in payload)) continue;

    const value = payload[apiKey];

    if (field.behavior === 'readonly') continue;

    if (field.behavior === 'hashed') {
      result[field.db] = await hashPassword(value);
      continue;
    }

    result[field.db] = value;
  }

  return result;
}

export function transformForRead(
  table: AllowedTable,
  row: Record<string, any>
) {
    console.log("transformForRead");
    
  const fields = TABLE_FIELD_MAP[table];
  const result: Record<string, any> = {};

  for (const [apiKey, field] of Object.entries(fields)) {
    if (field.behavior === 'hashed') continue;
    result[apiKey] = row[field.db];
  }

  return result;
}
