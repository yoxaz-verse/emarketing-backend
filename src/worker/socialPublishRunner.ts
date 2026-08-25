import { processDueSocialPublishJobs } from '../services/social/social.service';
import { formatUnknownError } from '../utils/errorFormat';

const SOCIAL_PUBLISH_RUNNER_ENABLED = String(process.env.SOCIAL_PUBLISH_RUNNER_ENABLED ?? 'true') !== 'false';
const SOCIAL_PUBLISH_TICK_MS = Number(process.env.SOCIAL_PUBLISH_TICK_MS ?? 30000);

let timer: NodeJS.Timeout | null = null;
let running = false;

async function tick() {
  if (running) return;
  running = true;
  try {
    const result = await processDueSocialPublishJobs(25);
    if (result.processed > 0) {
      console.info('[SOCIAL_PUBLISH_RUNNER_TICK_OK]', { processed: result.processed });
    }
  } catch (error) {
    console.error('[SOCIAL_PUBLISH_RUNNER_TICK_ERROR]', formatUnknownError(error));
  } finally {
    running = false;
  }
}

export function startSocialPublishRunner() {
  if (!SOCIAL_PUBLISH_RUNNER_ENABLED) {
    console.info('[SOCIAL_PUBLISH_RUNNER_DISABLED]');
    return;
  }

  if (timer) return;
  console.info('[SOCIAL_PUBLISH_RUNNER_STARTED]', { intervalMs: SOCIAL_PUBLISH_TICK_MS });
  void tick();
  timer = setInterval(() => {
    void tick();
  }, Math.max(5000, SOCIAL_PUBLISH_TICK_MS));
}
