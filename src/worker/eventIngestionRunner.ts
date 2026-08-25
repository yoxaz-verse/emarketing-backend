import { runEventIngestion } from '../services/events.service';
import { formatUnknownError } from '../utils/errorFormat';

const EVENT_INGESTION_RUNNER_ENABLED = String(process.env.EVENT_INGESTION_RUNNER_ENABLED ?? 'true') !== 'false';
const EVENT_INGESTION_TICK_MS = Number(process.env.EVENT_INGESTION_TICK_MS ?? 60 * 60 * 1000);

let timer: NodeJS.Timeout | null = null;
let running = false;

async function tick() {
  if (running) return;
  running = true;
  try {
    const result = await runEventIngestion(null);
    if (result.processed_sources > 0 || result.inserted_count > 0) {
      console.info('[EVENT_INGESTION_RUNNER_TICK_OK]', {
        processedSources: result.processed_sources,
        inserted: result.inserted_count,
        skipped: result.skipped_count,
        errors: result.error_count,
      });
    }
  } catch (error) {
    console.error('[EVENT_INGESTION_RUNNER_TICK_ERROR]', formatUnknownError(error));
  } finally {
    running = false;
  }
}

export function startEventIngestionRunner() {
  if (!EVENT_INGESTION_RUNNER_ENABLED) {
    console.info('[EVENT_INGESTION_RUNNER_DISABLED]');
    return;
  }

  if (timer) return;
  console.info('[EVENT_INGESTION_RUNNER_STARTED]', {
    intervalMs: Math.max(60_000, EVENT_INGESTION_TICK_MS),
  });
  timer = setInterval(() => {
    void tick();
  }, Math.max(60_000, EVENT_INGESTION_TICK_MS));
}
