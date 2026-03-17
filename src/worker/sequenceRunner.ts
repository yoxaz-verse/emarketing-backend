import { runSequenceSteps } from '../services/sequenceEngine';

let isRunning = false;

export function startSequenceRunner() {
  const intervalMs = Number(process.env.SEQUENCE_RUNNER_INTERVAL_MS ?? 5000);
  const enabled = process.env.SEQUENCE_RUNNER_ENABLED !== 'false';

  if (!enabled) {
    console.log('[SequenceRunner] Disabled by env flag.');
    return;
  }

  const tick = async () => {
    if (isRunning) return;
    isRunning = true;

    try {
      const processed = await runSequenceSteps();
      if (processed > 0) {
        console.log(`[SequenceRunner] Processed ${processed} step(s).`);
      }
    } catch (err) {
      console.error('[SequenceRunner] Error:', err);
    } finally {
      isRunning = false;
    }
  };

  tick();
  setInterval(tick, intervalMs);
}
