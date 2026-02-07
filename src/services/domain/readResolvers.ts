import { resolveLeadsRead } from "./leadLifeCycle";
import { resolveVoiceAgentsRead } from "./voiceAgentLifeCycle";

export async function resolveAfterRead(
  table: string,
  rows: any[]
): Promise<any[]> {
  if (table === 'voice_agents') {
    return resolveVoiceAgentsRead(rows);
  }
  if (table === 'leads') {
    return resolveLeadsRead(rows);
  }

  return rows;
}
