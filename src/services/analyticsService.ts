import { supabase } from '../supabase.js';

export async function getOverviewStats() {
  const { data: inboxes } = await supabase
    .from('inbox_analytics')
    .select('*');

  const { data: daily } = await supabase
    .from('daily_send_stats')
    .select('*')
    .limit(7);

  return { inboxes, daily };
}

export async function getInboxAnalytics() {
  const { data } = await supabase
    .from('inbox_analytics')
    .select('*');

  return data;
}

export async function getSequenceAnalytics() {
  const { data } = await supabase
    .from('sequence_analytics')
    .select('*');

  return data;
}
