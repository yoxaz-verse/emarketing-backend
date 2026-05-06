import nodemailer from 'nodemailer';
import type { ConnectionOptions } from 'tls';

type SmtpRow = {
  provider?: string | null;
  host: string;
  port: number;
  username: string;
  password: string;
  encryption?: string | null;
};

function normalizeProvider(provider?: string | null): string {
  return String(provider ?? '').trim().toLowerCase();
}

function normalizeEncryption(encryption?: string | null, port?: number): 'ssl' | 'tls' {
  const normalized = String(encryption ?? '').trim().toLowerCase();
  if (normalized === 'ssl' || normalized === 'tls') return normalized;
  return Number(port) === 465 ? 'ssl' : 'tls';
}

export function getSniCandidates(smtp: SmtpRow): string[] {
  const provider = normalizeProvider(smtp.provider);
  const host = String(smtp.host ?? '').trim().toLowerCase();
  const candidates =
    provider === 'mxroute'
      ? [host, 'shared.mxroute.com', 'mxrouting.net', 'mail.mxrouting.net']
      : [host];

  return [...new Set(candidates.filter(Boolean))];
}

function buildTlsOptions(servername?: string): ConnectionOptions | undefined {
  if (!servername) return undefined;
  return { servername };
}

export function createSmtpTransport(smtp: SmtpRow, servername?: string) {
  const encryption = normalizeEncryption(smtp.encryption, smtp.port);

  return nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: encryption === 'ssl',
    auth: {
      user: smtp.username,
      pass: smtp.password,
    },
    tls: buildTlsOptions(servername),
  });
}

export function formatSmtpValidationError(
  error: unknown,
  provider?: string | null,
  details?: {
    host?: string;
    port?: number;
    encryption?: string | null;
    attemptedSni?: string[];
  }
): string {
  const message = error instanceof Error ? error.message : String(error ?? 'SMTP verification failed');
  const providerName = normalizeProvider(provider);

  if (
    providerName === 'mxroute' &&
    (message.includes("does not match certificate's altnames") || message.includes('ERR_TLS_CERT_ALTNAME_INVALID'))
  ) {
    const attempted = details?.attemptedSni?.length
      ? ` Tried SNI: ${details.attemptedSni.join(', ')}.`
      : '';
    return `TLS hostname mismatch for MXroute (${details?.host ?? 'unknown-host'}:${details?.port ?? 'unknown-port'}).${attempted}`;
  }

  return message;
}
