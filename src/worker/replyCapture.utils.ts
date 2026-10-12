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

export type ReplyCaptureStatus = 'healthy' | 'stale' | 'misconfigured' | 'failed' | 'disabled';
export type SkippedInboxReason =
  | 'missing_smtp_account'
  | 'missing_host'
  | 'missing_username'
  | 'missing_password';

export type ReplyCaptureInboxConfig = {
  id?: unknown;
  email_address?: unknown;
  smtp_accounts?: {
    host?: unknown;
    username?: unknown;
    password?: unknown;
  } | null;
};

export function classifyReplyCaptureInbox(
  row: ReplyCaptureInboxConfig,
  authoritativeHost = '',
): SkippedInboxReason | null {
  const smtp = row.smtp_accounts;
  if (!smtp) return 'missing_smtp_account';
  if (!authoritativeHost.trim() && !String(smtp.host ?? '').trim()) return 'missing_host';
  if (!String(smtp.username ?? '').trim()) return 'missing_username';
  if (!String(smtp.password ?? '').trim()) return 'missing_password';
  return null;
}

export function deriveReplyCaptureStatus(input: {
  enabled: boolean;
  eligibleInboxCount: number;
  failedInboxCount: number;
  lastCycleError: string | null;
  lastCycleAt: string | null;
  lastPollAt: string | null;
  stale: boolean;
}): ReplyCaptureStatus {
  if (!input.enabled) return 'disabled';
  if (input.eligibleInboxCount === 0) return 'misconfigured';
  if (input.failedInboxCount > 0 || input.lastCycleError || (input.lastCycleAt && !input.lastPollAt)) return 'failed';
  if (input.stale && input.lastPollAt) return 'stale';
  return 'healthy';
}

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
