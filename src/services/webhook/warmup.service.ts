import { supabase } from "../../supabase";

type WarmupStep = {
  day: number;
  daily_limit: number;
  hourly_limit: number;
};

export async function advanceInboxWarmup() {
  // 1. Fetch warmup config (single row / json column / table)
  const { data: warmupConfigRow, error: configError } = await supabase
    .from('warmup_config')
    .select('steps')
    .single();

  if (configError || !warmupConfigRow) return;

  const steps = warmupConfigRow.steps as WarmupStep[];

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
    if (inbox.consecutive_failures >= 3) continue;
    if (inbox.health_score < 70) continue;

    const currentDay = inbox.warmup_day ?? 1;
    const nextDay = currentDay + 1;

    const step = steps.find(s => s.day === nextDay);
    if (!step) continue; // warmup complete

    await supabase
      .from('inboxes')
      .update({
        warmup_day: nextDay,
        daily_send_limit: step.daily_limit,
        hourly_send_limit: step.hourly_limit,
      })
      .eq('id', inbox.id);
  }
}
