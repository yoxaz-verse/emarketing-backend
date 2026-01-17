import { supabase } from "../../supabase";

function clamp(score: number) {
  return Math.max(0, Math.min(100, score));
}

/**
 * Called on successful send
 */
export async function onSendSuccess(inboxId: string) {
  const { data: inbox } = await supabase
    .from('inboxes')
    .select('health_score, consecutive_failures')
    .eq('id', inboxId)
    .single();

  if (!inbox) return;

  await supabase
    .from('inboxes')
    .update({
      health_score: clamp((inbox.health_score ?? 100) + 1),
      consecutive_failures: 0,
    })
    .eq('id', inboxId);
}

/**
 * Called on temporary failure
 */
export async function onSoftFailure(inboxId: string) {
  const { data: inbox } = await supabase
    .from('inboxes')
    .select('health_score, consecutive_failures')
    .eq('id', inboxId)
    .single();

  if (!inbox) return;

  const newFailures = (inbox.consecutive_failures ?? 0) + 1;

  await supabase
    .from('inboxes')
    .update({
      health_score: clamp((inbox.health_score ?? 100) - 5),
      consecutive_failures: newFailures,
    })
    .eq('id', inboxId);

  if (newFailures >= 3) {
    await applyHealthActions(inboxId);
  }
}

/**
 * Called on permanent failure / hard bounce
 */
export async function onHardFailure(inboxId: string) {
  const { data: inbox } = await supabase
    .from('inboxes')
    .select('health_score')
    .eq('id', inboxId)
    .single();

  if (!inbox) return;

  await supabase
    .from('inboxes')
    .update({
      health_score: clamp((inbox.health_score ?? 100) - 20),
    })
    .eq('id', inboxId);

  await applyHealthActions(inboxId);
}

/**
 * Enforce pause rules based on health score
 */
async function applyHealthActions(inboxId: string) {
  const { data: inbox } = await supabase
    .from('inboxes')
    .select('health_score, is_paused, hard_paused')
    .eq('id', inboxId)
    .single();

  if (!inbox) return;

  if (inbox.health_score < 30 && !inbox.hard_paused) {
    await supabase
      .from('inboxes')
      .update({
        hard_paused: true,
        paused_reason: 'Inbox health critically low',
      })
      .eq('id', inboxId);
    return;
  }

  if (inbox.health_score < 50 && !inbox.is_paused) {
    await supabase
      .from('inboxes')
      .update({
        is_paused: true,
        paused_reason: 'Inbox health degraded',
      })
      .eq('id', inboxId);
  }
}






export async function dailyHealthRecovery() {
    const { data: inboxes } = await supabase
      .from('inboxes')
      .select('id, health_score, is_paused, hard_paused');
  
    if (!inboxes) return;
  
    for (const inbox of inboxes) {
      if (inbox.hard_paused) continue;
  
      const newScore = clamp((inbox.health_score ?? 100) + 5);
  
      await supabase
        .from('inboxes')
        .update({
          health_score: newScore,
          ...(newScore >= 50 ? { is_paused: false } : {}),
        })
        .eq('id', inbox.id);
    }
  }
  