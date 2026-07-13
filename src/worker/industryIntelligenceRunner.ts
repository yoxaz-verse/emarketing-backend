import { createIndustryFetchRun, listIndustrySources } from '../services/industry-intelligence/industryIntelligence.service';

const RUNNER_ENABLED = String(process.env.INDUSTRY_INTELLIGENCE_RUNNER_ENABLED ?? 'true') !== 'false';
const TICK_MS = Number(process.env.INDUSTRY_INTELLIGENCE_TICK_MS ?? 6 * 60 * 60 * 1000);
const DEFAULT_LIMIT = Number(process.env.INDUSTRY_INTELLIGENCE_DEFAULT_LIMIT ?? 12);

let running = false;

async function runOnce() {
  if (running) return;
  running = true;
  try {
    const sources = await listIndustrySources();
    const sourceCodes = sources
      .filter((source) => source.status === 'active' && source.supports_fetch && source.mode !== 'webhook')
      .slice(0, Math.max(1, DEFAULT_LIMIT))
      .map((source) => source.code);

    if (sourceCodes.length === 0) {
      console.info('[INDUSTRY_INTELLIGENCE_RUNNER_NO_SOURCES]');
      return;
    }

    const result = await createIndustryFetchRun({
      sourceCodes,
      triggerMode: 'scheduled_fetch',
    });

    console.info('[INDUSTRY_INTELLIGENCE_RUNNER_TICK_OK]', {
      sources: sourceCodes.length,
      inserted: result.summary.inserted_count,
      deduped: result.summary.deduped_count,
      failed: result.summary.failed_count,
    });
  } catch (error: any) {
    console.error('[INDUSTRY_INTELLIGENCE_RUNNER_TICK_ERROR]', error?.message ?? error);
  } finally {
    running = false;
  }
}

export function startIndustryIntelligenceRunner() {
  if (!RUNNER_ENABLED) {
    console.info('[INDUSTRY_INTELLIGENCE_RUNNER_DISABLED]');
    return;
  }

  console.info('[INDUSTRY_INTELLIGENCE_RUNNER_STARTED]', {
    intervalMs: Math.max(60_000, TICK_MS),
    defaultLimit: DEFAULT_LIMIT,
  });

  void runOnce();
  setInterval(() => void runOnce(), Math.max(60_000, TICK_MS));
}
