import { supabase } from '../supabase.js';

export async function getOperatorReplies(  operatorId: string | null
) {
  const { data } = await supabase
    .from('leads')
    .select(`
      id,
      email,
      first_name,
      company,
      country,
      replied_at,
      reply_message,
      inboxes (
        email_address
      )
    `)
    .eq('operator_id', operatorId)
    .eq('status', 'replied')
    .order('replied_at', { ascending: false });

  return data ?? [];
}
