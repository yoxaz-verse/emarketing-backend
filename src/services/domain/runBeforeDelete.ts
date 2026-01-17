import { AllowedTable } from '../../config/allowedTables';
import { handleUserBeforeDelete } from './userLifeCycle';

export async function runBeforeDelete(
  table: AllowedTable,
  id: string
) {
  if (table === 'users') {
    await handleUserBeforeDelete(id);
  }

  // Add more tables later if needed
}
