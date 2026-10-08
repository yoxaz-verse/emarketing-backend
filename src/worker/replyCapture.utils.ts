export type ReplyCapturePhase =
  | 'idle'
  | 'connecting'
  | 'authenticating'
  | 'opening_mailbox'
  | 'searching_backfill'
  | 'fetching'
  | 'parsing'
  | 'ingesting'
  | 'persisting_cursor'
  | 'complete';

export function planUidFetch(lastUid: number, maxUid: number): string | null {
  const start = Math.max(1, Math.trunc(Number(lastUid) || 0) + 1);
  const end = Math.max(0, Math.trunc(Number(maxUid) || 0));
  return start <= end ? `${start}:${end}` : null;
}

export function sanitizeImapError(error: unknown): { message: string; code: string | null } {
  const value = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  const message = String(value.message ?? error ?? 'IMAP operation failed')
    .replace(/(pass(word)?|token|secret|authorization)\s*[=:]\s*\S+/gi, '$1=[redacted]')
    .slice(0, 500);
  const code = String(value.code ?? value.responseStatus ?? value.serverResponseCode ?? '').trim().slice(0, 100);
  return { message, code: code || null };
}
