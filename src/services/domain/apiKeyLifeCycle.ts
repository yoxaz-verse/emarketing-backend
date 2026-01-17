// src/lifecycle/apiKeys.lifecycle.ts
import crypto from 'crypto';
import { supabase } from '../../supabase';

export async function handleApiKeyBeforeWrite(
  payload: Record<string, any>,
  mode: 'create' | 'update'
) { 
  // Only generate on CREATE
  if (mode === 'create') {
    // 1. Generate raw key (return this ONCE to UI)
    const rawKey = crypto.randomBytes(32).toString('hex');

    // 2. Hash for storage
    const keyHash = crypto
      .createHash('sha256')
      .update(rawKey)
      .digest('hex');

    payload.key_hash = keyHash;
    payload.active = true;

    // Role & operator come from user
    if (payload.user_id) {
      const { data: user } = await supabase
        .from('users')
        .select('role, operator_id')
        .eq('id', payload.user_id)
        .single();

      if (user) {
        payload.role = user.role;
        payload.operator_id = user.operator_id;
      }
    }

    // IMPORTANT: return raw key to caller
    payload.__raw_key = rawKey;
  }
  return payload;
}
