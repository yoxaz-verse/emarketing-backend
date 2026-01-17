import { supabase } from '../supabase.js';

export async function listActiveSequences() {
  const { data } = await supabase
    .from('sequences')
    .select('id, name')
    .eq('active', true);

  return data ?? [];
}

