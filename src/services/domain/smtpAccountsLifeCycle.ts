// lifecycle/handleSmtpAccountBeforeWrite.ts

import { encryptSecret } from '../../utils/sendEncryption';
import { supabase } from '../../supabase';

export async function handleSmtpAccountBeforeWrite(
  payload: Record<string, any>,
  mode: 'create' | 'update',
  id?: string
) {
  // Required fields
  if (!payload.host) throw new Error('SMTP host is required');
  if (!payload.port) throw new Error('SMTP port is required');
  if (!payload.username) throw new Error('SMTP username is required');

  if (mode === 'create' && !payload.password) {
    throw new Error('SMTP password is required');
  }

  // Normalize username for stable uniqueness checks
  const normalizedUsername = String(payload.username).trim().toLowerCase();
  payload.username = normalizedUsername;

  // Enforce uniqueness at service layer (DB index should still be added)
  const duplicateQuery = supabase
    .from('smtp_accounts')
    .select('id')
    .eq('username', normalizedUsername)
    .limit(1);

  const { data: duplicate, error: duplicateError } =
    mode === 'update' && id
      ? await duplicateQuery.neq('id', id).maybeSingle()
      : await duplicateQuery.maybeSingle();

  if (duplicateError) {
    throw new Error(`Failed to validate SMTP username uniqueness: ${duplicateError.message}`);
  }

  if (duplicate) {
    throw new Error('SMTP username already exists. Please use a unique username/email.');
  }

  // Normalize encryption
  const encryption = payload.encryption?.toLowerCase();
  if (!['ssl', 'tls'].includes(encryption)) {
    throw new Error('Encryption must be ssl or tls');
  }
  payload.encryption = encryption;

  // Encrypt password ONLY if provided
  if (payload.password) {
    payload.password = encryptSecret(payload.password);
  }

  // Lifecycle hooks NEVER validate external services
  payload.is_valid = false;
  payload.error_message = null;

  return payload;
}
