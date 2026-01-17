import { resolveLeadsRead } from "./leadLifeCycle";

export async function resolveAfterRead(
  table: string,
  rows: any[]
): Promise<any[]> {
  if (table === 'leads') {
    return resolveLeadsRead(rows);
  }

  return rows;
}
