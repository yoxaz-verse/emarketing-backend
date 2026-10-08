import { supabase } from '../supabase.js';
import { decryptSecret } from '../utils/sendEncryption.js';
import { ingestInboundReply } from '../services/replyIngestService.js';
import { formatUnknownError } from '../utils/errorFormat.js';
import { planUidFetch, ReplyCapturePhase, sanitizeImapError } from './replyCapture.utils.js';

type InboxPollTarget = {
  inbox_id: string;
  inbox_email: string;
  username: string;
  password: string;
  host: string;
  port: number;
  secure: boolean;
};

type ReplyCaptureHealth = {
  enabled: boolean;
  running: boolean;
  started_at: string | null;
  last_poll_at: string | null;
  stale: boolean;
  stale_threshold_minutes: number;
  poll_interval_seconds: number;
  scanned: number;
  ingested: number;
  unmatched: number;
  parser_failures: number;
  active_inbox_count: number;
  failed_inbox_count: number;
  inboxes: Array<{
    inbox_email: string;
    connect_ok: boolean;
    auth_ok: boolean;
    mailbox_open_ok: boolean;
    last_poll_at: string | null;
    last_error_at: string | null;
    last_uid: number;
    uid_validity: string | null;
    phase: ReplyCapturePhase;
    last_success_at: string | null;
    scanned: number;
    ingested: number;
    unmatched: number;
    parser_failures: number;
    last_error: string | null;
    last_error_code: string | null;
  }>;
};

const POLL_INTERVAL_MS = Math.max(30_000, Number(process.env.REPLY_CAPTURE_POLL_INTERVAL_MS ?? 90_000));
const STALE_THRESHOLD_MINUTES = Math.max(2, Number(process.env.REPLY_CAPTURE_STALE_MINUTES ?? 5));
const ENABLED = String(process.env.ENABLE_REPLY_CAPTURE_IMAP ?? 'true').toLowerCase() === 'true';
const INCLUDE_SPAM = String(process.env.REPLY_CAPTURE_INCLUDE_SPAM ?? 'false').toLowerCase() === 'true';
const DEFAULT_IMAP_PORT = Number(process.env.REPLY_CAPTURE_IMAP_PORT ?? 993);
const DEFAULT_IMAP_SECURE = String(process.env.REPLY_CAPTURE_IMAP_SECURE ?? 'true').toLowerCase() !== 'false';
const DEFAULT_IMAP_HOST = String(process.env.REPLY_CAPTURE_IMAP_HOST ?? '').trim().toLowerCase();
const BACKFILL_DAYS = Math.max(1, Number(process.env.REPLY_CAPTURE_BACKFILL_DAYS ?? 7));
const BACKFILL_ENABLED = String(process.env.REPLY_CAPTURE_BACKFILL_ENABLED ?? 'true').toLowerCase() === 'true';

let timer: NodeJS.Timeout | null = null;
let cycleRunning = false;
const mailboxState = new Map<string, {
  lastUid: number;
  lastPollAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  lastErrorCode: string | null;
  lastSuccessAt: string | null;
  uidValidity: string | null;
  phase: ReplyCapturePhase;
  scanned: number;
  ingested: number;
  unmatched: number;
  parserFailures: number;
  connectOk: boolean;
  authOk: boolean;
  mailboxOpenOk: boolean;
  didBackfill: boolean;
}>();
const health: ReplyCaptureHealth = {
  enabled: ENABLED,
  running: false,
  started_at: null,
  last_poll_at: null,
  stale: false,
  stale_threshold_minutes: STALE_THRESHOLD_MINUTES,
  poll_interval_seconds: Math.round(POLL_INTERVAL_MS / 1000),
  scanned: 0,
  ingested: 0,
  unmatched: 0,
  parser_failures: 0,
  active_inbox_count: 0,
  failed_inbox_count: 0,
  inboxes: [],
};

function normalizeMessageId(value: unknown): string | null {
  const normalized = String(value ?? '').trim().replace(/[<>]/g, '').toLowerCase();
  return normalized || null;
}

function parseMailboxHost(smtpHost: string | null): string {
  // A configured IMAP endpoint is authoritative. SMTP vanity hosts frequently do
  // not expose IMAP, which was the cause of every inbox using mail.<domain>.
  if (DEFAULT_IMAP_HOST) return DEFAULT_IMAP_HOST;
  const host = String(smtpHost ?? '').trim().toLowerCase();
  if (!host) return '';
  if (host.startsWith('smtp.')) return host.replace(/^smtp\./, 'mail.');
  if (host.startsWith('mail.')) return host;
  return host;
}

async function loadCursor(inboxId: string) {
  const { data, error } = await supabase
    .from('reply_capture_cursors')
    .select('last_uid,uid_validity,last_success_at,last_error_at,last_error_code,last_error_message')
    .eq('inbox_id', inboxId)
    .maybeSingle();
  if (error) throw error;
  return data as any;
}

async function saveCursor(target: InboxPollTarget, state: any) {
  const { error } = await supabase.from('reply_capture_cursors').upsert({
    inbox_id: target.inbox_id,
    mailbox_name: 'INBOX',
    host: target.host,
    uid_validity: state.uidValidity,
    last_uid: state.lastUid,
    last_success_at: state.lastSuccessAt,
    last_error_at: state.lastErrorAt,
    last_error_code: state.lastErrorCode,
    last_error_message: state.lastError,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'inbox_id,mailbox_name' });
  if (error) throw error;
}

function backfillStartIso(): string {
  return new Date(Date.now() - (BACKFILL_DAYS * 24 * 60 * 60 * 1000)).toISOString();
}

async function getInboxTargets(): Promise<InboxPollTarget[]> {
  const { data, error } = await supabase
    .from('inboxes')
    .select(`
      id,
      email_address,
      status,
      smtp_accounts:smtp_accounts!inboxes_smtp_account_id_fkey (
        host,
        port,
        username,
        password,
        encryption
      )
    `)
    .eq('status', 'active');

  if (error) throw error;

  const targets: InboxPollTarget[] = [];
  for (const row of data ?? []) {
    const smtp = (row as any)?.smtp_accounts;
    const username = String(smtp?.username ?? '').trim();
    const encryptedPassword = String(smtp?.password ?? '').trim();
    const host = parseMailboxHost(String(smtp?.host ?? ''));
    if (!username || !encryptedPassword || !host) continue;
    const password = decryptSecret(encryptedPassword);
    const encryption = String(smtp?.encryption ?? '').toLowerCase();
    targets.push({
      inbox_id: String((row as any).id),
      inbox_email: String((row as any).email_address ?? '').trim().toLowerCase(),
      username,
      password,
      host,
      port: DEFAULT_IMAP_PORT,
      secure: encryption.includes('ssl') || encryption.includes('tls') || DEFAULT_IMAP_SECURE,
    });
  }
  return targets;
}

async function pollInbox(target: InboxPollTarget) {
  const state = mailboxState.get(target.inbox_id) ?? {
    lastUid: 0,
    lastPollAt: null,
    lastError: null,
    lastErrorAt: null,
    lastErrorCode: null,
    lastSuccessAt: null,
    uidValidity: null,
    phase: 'idle' as ReplyCapturePhase,
    scanned: 0,
    ingested: 0,
    unmatched: 0,
    parserFailures: 0,
    connectOk: false,
    authOk: false,
    mailboxOpenOk: false,
    didBackfill: false,
  };
  mailboxState.set(target.inbox_id, state);
  state.connectOk = false;
  state.authOk = false;
  state.mailboxOpenOk = false;

  if (!state.didBackfill && state.lastUid === 0) {
    const cursor = await loadCursor(target.inbox_id);
    if (cursor) {
      state.lastUid = Number(cursor.last_uid ?? 0);
      state.uidValidity = String(cursor.uid_validity ?? '') || null;
      state.lastSuccessAt = cursor.last_success_at ?? null;
      state.lastErrorAt = cursor.last_error_at ?? null;
      state.lastErrorCode = cursor.last_error_code ?? null;
      state.lastError = cursor.last_error_message ?? null;
      state.didBackfill = true;
    }
  }
  state.lastError = null;
  state.lastErrorCode = null;
  state.lastErrorAt = null;

  const { ImapFlow } = await import('imapflow');
  const { simpleParser } = await import('mailparser');
  const client = new ImapFlow({
    host: target.host,
    port: target.port,
    secure: target.secure,
    auth: { user: target.username, pass: target.password },
    logger: false,
  } as any);

  try {
    state.phase = 'connecting';
    await client.connect();
    state.connectOk = true;
    state.authOk = true;
    state.phase = 'opening_mailbox';
    await client.mailboxOpen('INBOX');
    state.mailboxOpenOk = true;
    const maxUid = Number(client.mailbox?.exists ? client.mailbox.uidNext - 1 : 0);
    const uidValidity = String(client.mailbox?.uidValidity ?? '') || null;
    if (state.uidValidity && uidValidity && state.uidValidity !== uidValidity) {
      state.lastUid = 0;
      state.didBackfill = false;
    }
    state.uidValidity = uidValidity;

    if (!state.didBackfill) {
      if (BACKFILL_ENABLED && maxUid > 0) {
        state.phase = 'searching_backfill';
        const matches = await client.search({ since: new Date(backfillStartIso()) }, { uid: true });
        const firstUid = Array.isArray(matches) && matches.length > 0
          ? Math.min(...matches.map(Number).filter(Number.isFinite))
          : maxUid + 1;
        state.lastUid = Math.max(0, firstUid - 1);
      } else {
        state.lastUid = maxUid;
      }
      state.didBackfill = true;
      state.phase = 'persisting_cursor';
      await saveCursor(target, state);
    }

    const uidRange = planUidFetch(state.lastUid, maxUid);
    if (uidRange) for await (const msg of client.fetch(uidRange, { uid: true, source: true, envelope: true, internalDate: true }, { uid: true })) {
      state.scanned += 1;
      health.scanned += 1;
      try {
        state.phase = 'parsing';
        const parsed = await simpleParser(msg.source);
        const from = parsed.from?.value?.[0]?.address?.toLowerCase() ?? null;
        if (!from || from === target.inbox_email) {
          state.lastUid = Number(msg.uid ?? state.lastUid);
          state.phase = 'persisting_cursor';
          await saveCursor(target, state);
          continue;
        }
        const inReplyTo = normalizeMessageId(parsed.inReplyTo);
        const references = Array.isArray(parsed.references) ? parsed.references.map(normalizeMessageId).filter(Boolean) as string[] : [];
        // Correlation uses the outbound parent only. The inbound message ID is
        // independently stored in own_message_id for dedupe and threading.
        const messageId = inReplyTo || references[0] || null;
        const text = String(parsed.text ?? parsed.html ?? '').trim();

        state.phase = 'ingesting';
        const result = await ingestInboundReply({
          from_email: from,
          inbox_email: target.inbox_email,
          message_id: messageId ?? undefined,
          own_message_id: parsed.messageId?.replace(/^<|>$/g, ''),
          in_reply_to: parsed.inReplyTo?.replace(/^<|>$/g, ''),
          reference_ids: (Array.isArray(parsed.references) ? parsed.references : parsed.references ? [parsed.references] : []).map((id: string) => id.replace(/^<|>$/g, '')),
          subject: parsed.subject,
          message: text || undefined,
          received_at: msg.internalDate ? new Date(msg.internalDate).toISOString() : new Date().toISOString(),
          source: 'imap_poll',
        });
        if (!result?.deduped) {
          state.ingested += 1;
          health.ingested += 1;
          if (!result?.matched) {
            state.unmatched += 1;
            health.unmatched += 1;
          }
        }
        state.lastUid = Number(msg.uid ?? state.lastUid);
        state.phase = 'persisting_cursor';
        await saveCursor(target, state);
      } catch (err: any) {
        state.parserFailures += 1;
        health.parser_failures += 1;
        const sanitized = sanitizeImapError(err);
        state.lastError = sanitized.message;
        state.lastErrorCode = sanitized.code;
        state.lastErrorAt = new Date().toISOString();
        await saveCursor(target, state);
        break;
      }
    }

    if (state.lastError) return;

    if (INCLUDE_SPAM) {
      try {
        await client.mailboxOpen('Junk');
      } catch {
        try {
          await client.mailboxOpen('Spam');
        } catch {
          // mailbox name varies; ignore
        }
      }
    }

    state.lastError = null;
    state.lastErrorCode = null;
    state.lastErrorAt = null;
    state.lastPollAt = new Date().toISOString();
    state.lastSuccessAt = state.lastPollAt;
    state.phase = 'complete';
    await saveCursor(target, state);
    health.last_poll_at = state.lastPollAt;
  } catch (err: any) {
    const sanitized = sanitizeImapError(err);
    if (/auth|credential|login|password/i.test(`${sanitized.code ?? ''} ${sanitized.message}`)) {
      state.phase = 'authenticating';
    }
    state.lastError = sanitized.message;
    state.lastErrorCode = sanitized.code;
    state.lastErrorAt = new Date().toISOString();
    if (!state.connectOk) state.authOk = false;
    if (!state.authOk) state.mailboxOpenOk = false;
    try { await saveCursor(target, state); } catch { /* preserve original IMAP failure */ }
  } finally {
    try {
      await client.logout();
    } catch {
      // noop
    }
  }
}

async function runPollCycle() {
  if (!ENABLED || cycleRunning) return;
  cycleRunning = true;
  try {
    const targets = await getInboxTargets();
    health.active_inbox_count = targets.length;
    for (const target of targets) {
      // eslint-disable-next-line no-await-in-loop
      await pollInbox(target);
    }
  const nowMs = Date.now();
  const staleCutoffMs = STALE_THRESHOLD_MINUTES * 60 * 1000;
  const lastPollMs = health.last_poll_at ? new Date(health.last_poll_at).getTime() : 0;
  health.stale = !lastPollMs || (nowMs - lastPollMs) > staleCutoffMs;
  let failed = 0;
  health.inboxes = targets.map((target) => {
    const state = mailboxState.get(target.inbox_id);
    const hasError = Boolean(state?.lastError);
    if (hasError) failed += 1;
    return {
      inbox_email: target.inbox_email,
      connect_ok: Boolean(state?.connectOk),
      auth_ok: Boolean(state?.authOk),
      mailbox_open_ok: Boolean(state?.mailboxOpenOk),
      last_poll_at: state?.lastPollAt ?? null,
      last_error_at: state?.lastErrorAt ?? null,
      last_uid: Number(state?.lastUid ?? 0),
      uid_validity: state?.uidValidity ?? null,
      phase: state?.phase ?? 'idle',
      last_success_at: state?.lastSuccessAt ?? null,
      scanned: Number(state?.scanned ?? 0),
      ingested: Number(state?.ingested ?? 0),
      unmatched: Number(state?.unmatched ?? 0),
      parser_failures: Number(state?.parserFailures ?? 0),
      last_error: state?.lastError ?? null,
      last_error_code: state?.lastErrorCode ?? null,
    };
  });
    health.failed_inbox_count = failed;
  } finally {
    cycleRunning = false;
  }
}

export function startReplyCaptureWorker() {
  if (!ENABLED || timer) return;
  health.running = true;
  health.started_at = new Date().toISOString();
  runPollCycle().catch((err) => {
    console.error('[REPLY_CAPTURE_WORKER_BOOT_ERROR]', formatUnknownError(err));
  });
  timer = setInterval(() => {
    runPollCycle().catch((err) => {
      console.error('[REPLY_CAPTURE_WORKER_POLL_ERROR]', formatUnknownError(err));
    });
  }, POLL_INTERVAL_MS);
}

export function getReplyCaptureHealth(): ReplyCaptureHealth {
  const nowMs = Date.now();
  const staleCutoffMs = STALE_THRESHOLD_MINUTES * 60 * 1000;
  const lastPollMs = health.last_poll_at ? new Date(health.last_poll_at).getTime() : 0;
  return {
    ...health,
    stale: !lastPollMs || (nowMs - lastPollMs) > staleCutoffMs,
    inboxes: [...health.inboxes],
  };
}
