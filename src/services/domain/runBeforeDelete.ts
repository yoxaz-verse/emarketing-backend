import { AllowedTable } from '../../config/allowedTables';
import { handleUserBeforeDelete } from './userLifeCycle';
import { handleVoiceAgentsBeforeDelete } from './voiceAgentLifeCycle';

export async function runBeforeDelete(
  table: AllowedTable,
  id: string
) {
  if (table === 'voice_agents') {
    await handleVoiceAgentsBeforeDelete();
  }
  if (table === 'users') {
    await handleUserBeforeDelete(id);
  }

  // Add more tables later if needed
}
