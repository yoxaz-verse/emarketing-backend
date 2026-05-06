import { supabase } from "../../supabase";
import { getSendingLimitsConfig } from '../sendingLimitsConfig.service';

export async function advanceInboxWarmup() {
  const config = await getSendingLimitsConfig();
  const steps = config.warmup_steps;

  // 2. Fetch inboxes in warmup
  const { data: inboxes } = await supabase
    .from('inboxes')
    .select(`
      id,
      warmup_enabled,
      warmup_day,
      consecutive_failures,
      health_score,
      hard_paused
    `)
    .eq('warmup_enabled', true)
    .eq('hard_paused', false);

  if (!inboxes || inboxes.length === 0) return;

  for (const inbox of inboxes) {
    // Safety guards
    if (inbox.consecutive_failures > config.warmup_advance_max_consecutive_failures) continue;
    if (inbox.health_score < config.warmup_advance_min_health_score) continue;

    const currentDay = inbox.warmup_day ?? 1;
    const nextDay = currentDay + 1;

    const step = steps.find(s => s.day === nextDay);
    if (!step) continue; // warmup complete

    await supabase
      .from('inboxes')
      .update({
        warmup_day: nextDay,
        daily_limit: step.daily_limit,
        hourly_limit: step.hourly_limit,
      })
      .eq('id', inbox.id);
  }
}
