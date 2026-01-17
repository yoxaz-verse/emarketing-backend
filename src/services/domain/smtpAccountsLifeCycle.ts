// lifecycle/handleSmtpAccountBeforeWrite.ts

import { encryptSecret } from '../../utils/sendEncryption';

export async function handleSmtpAccountBeforeWrite(
  payload: Record<string, any>,
  mode: 'create' | 'update'
) {
  // Required fields
  if (!payload.host) throw new Error('SMTP host is required');
  if (!payload.port) throw new Error('SMTP port is required');
  if (!payload.username) throw new Error('SMTP username is required');

  if (mode === 'create' && !payload.password) {
    throw new Error('SMTP password is required');
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
