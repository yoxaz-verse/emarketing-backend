import { dispatchDueMissions } from '../services/agents/agentMissions.service';

const AGENT_MISSION_RUNNER_ENABLED = String(process.env.AGENT_MISSION_RUNNER_ENABLED ?? 'true') !== 'false';
const AGENT_MISSION_TICK_MS = Number(process.env.AGENT_MISSION_TICK_MS ?? 30000);

let timer: NodeJS.Timeout | null = null;
let running = false;

async function tick() {
  if (running) return;
  running = true;
  try {
    await dispatchDueMissions(25);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[AGENT_MISSION_RUNNER_TICK_ERROR]', message);
  } finally {
    running = false;
  }
}

export function startAgentMissionRunner() {
  if (!AGENT_MISSION_RUNNER_ENABLED) {
    console.info('[AGENT_MISSION_RUNNER_DISABLED]');
    return;
  }

  if (timer) return;
  console.info('[AGENT_MISSION_RUNNER_STARTED]', { intervalMs: AGENT_MISSION_TICK_MS });
  void tick();
  timer = setInterval(() => {
    void tick();
  }, Math.max(5000, AGENT_MISSION_TICK_MS));
}

