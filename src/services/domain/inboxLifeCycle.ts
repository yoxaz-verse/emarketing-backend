import { supabase } from '../../supabase';

function normalizeEmail(value: unknown): string {
  return String(value ?? '').trim().toLowerCase();
}

export async function handleInboxBeforeWrite(
  payload: Record<string, any>,
  mode: 'create' | 'update',
  id?: string
) {
  const normalizedEmail = normalizeEmail(payload.email_address);

  if (!normalizedEmail) {
    throw new Error('Inbox email is required');
  }

  payload.email_address = normalizedEmail;

  // Enforce uniqueness at service layer (DB unique index should still exist)
  const duplicateQuery = supabase
    .from('inboxes')
    .select('id')
    .eq('email_address', normalizedEmail);

  const { data: duplicate, error: duplicateError } =
    mode === 'update' && id
      ? await duplicateQuery.neq('id', id).maybeSingle()
      : await duplicateQuery.maybeSingle();

  if (duplicateError) {
    throw new Error(`Failed to validate inbox email uniqueness: ${duplicateError.message}`);
  }

  if (duplicate) {
    throw new Error('Inbox email already exists. Please use a unique email address.');
  }

  if (mode === 'create') {
    // Normalize defaults (not validation)
    payload.is_paused = false;
    payload.hard_paused = false;
    payload.consecutive_failures = 0;
    payload.health_score = payload.health_score ?? 100;

    // Enforce email ↔ domain alignment
    if (payload.email_address && payload.sending_domain?.domain) {
      const emailDomain = payload.email_address.split('@')[1];
      if (emailDomain !== payload.sending_domain.domain) {
        throw new Error(
          `Inbox email domain (${emailDomain}) must match sending domain`
        );
      }
    }
  }

  return payload;
}
  
