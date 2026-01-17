import { TABLE_FIELD_MAP } from "../config/tableFieldMap";

export function buildSelect(table: string) {
    const fields = TABLE_FIELD_MAP[table];
    if (!fields) return '*';
  
    const base: string[] = [];
    const relations: string[] = [];
  
    for (const [key, def] of Object.entries(fields)) {
      // always select base column
      base.push(def.db);
  
      if (def.behavior === 'relation' && def.relation) {
        const { table, valueKey, labelKey } = def.relation;
  
        relations.push(
          `${table} (${valueKey}, ${labelKey})`
        );
      }
    }
  
    return [...base, ...relations].join(',');
  }
  