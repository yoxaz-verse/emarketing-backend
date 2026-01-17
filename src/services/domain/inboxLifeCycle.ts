export async function handleInboxBeforeWrite(
    payload: Record<string, any>,
    mode: 'create' | 'update'
  ) {
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
  